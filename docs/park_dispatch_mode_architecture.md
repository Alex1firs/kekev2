# Park Dispatch Mode — Phase 0.5: Architecture Reconciliation & Final Plan

**Status:** Phase 0.5 deliverable. No production code changed, no migrations written, nothing merged or deployed.
**Date:** 2026-07-31
**Supersedes:** nothing. **Builds on:** [`park_dispatch_mode_discovery.md`](./park_dispatch_mode_discovery.md) (Phase 0), which remains the evidence record and is unmodified.

This document takes the approved product direction, reconciles it against the repository, and revises
the parts of the Phase 0 proposal that the direction changed. Where a Phase 0 recommendation is
overturned, §0.1 says so explicitly and gives the reason — the discovery report is not rewritten.

---

## §0.1 Revision log against Phase 0

| # | Phase 0 said | Phase 0.5 says | Why |
|---|---|---|---|
| R1 | The 4-char `pickupCode` is spoken aloud and confirmed by the passenger at boarding, as a **mandatory** step of every no-smartphone ride | The code stays exactly what it is today — a **passive, display-only** strip — and becomes an **exception-path** artefact only | Approved direction §2. Also: the code is already rendered in both apps and **never validated by the backend**, so mandating it would have been new friction *and* new enforcement code |
| R2 | Dispatchers are `User` rows with `role = 'park_dispatcher'` | Dispatchers are `StaffUser` rows in a **separate staff identity system** | Approved direction §6 requires a real staff entity with device binding, shifts and MFA. Mixing staff into the customer `User` table means a customer auth path can reach staff privileges |
| R3 | Strategy A — strictly sequential: direct completes, *then* the park is offered | **Strategy B** — park **pre-alert** during the final direct tier; park **ownership** still only after direct formally fails | Approved direction §4. Removes the dispatcher's cold-start decision latency from the critical path without ever letting a park own a ride direct dispatch could still win |
| R4 | Worst case ~4.5 min was presented as an open question | **Hard ceiling 180 s**, with a concrete mechanism to keep the existing passenger app from timing out | The passenger app has a **150 s client-side watchdog** (below) that Phase 0 did not account for |
| R5 | Passenger contact fix listed as a pre-existing defect to fix "before or alongside" | Promoted to **Phase 0.9**, with an explicit **two-release sequence**, because a naive fix silently removes the call button from every driver currently in the field | New finding (below) |
| R6 | Completion evidence = passenger GPS, single-shot at the completion tap | **Layered confidence model** with sampled passenger location during park rides, and a `startConfidence` / `completionConfidence` grade recorded on every ride | Approved direction §2 requires explicit confidence levels and forbids any single weak signal proving pickup |

### Two findings from this pass that change the plan

**F1 — The passenger app has a 150-second client-side search watchdog.**
`booking_controller.dart:25` — `_searchWatchdogTimeout = Duration(seconds: 150)`. On expiry it rolls the
passenger back to the fare estimate with `client_watchdog_timeout`. The server's budget is 110 s, so
today there is 40 s of headroom. **Any park phase that pushes total search past 150 s makes the
passenger's own app declare failure while the server is still working.**

The fix is already in the code and needs no app change: `_startWatchdog()` is re-armed on every
`ride:dispatch_round` event (`booking_controller.dart:154`), and the handler accepts any round greater
than the current one. `SearchingCopy.of(round)` renders **"Still searching nearby…"** for any round ≥ 2
and never prints the round number (`booking_notice.dart:250`). So emitting `ride:dispatch_round` with
`dispatchRound: 3` at the start of the park phase re-arms the watchdog on **builds already in the
field**, with honest copy and no version gate. New builds get park-specific copy.

**F2 — Removing `passengerPhone` from the offer payload would break the call button on every driver
phone in the field.**
The driver app builds its `TripRequest` from the **offer** payload (`driver_controller.dart:440`), and
`trip_operation_hud.dart:516,585` reads `state.activeRequest?.passengerPhone` for the in-ride call
action. `ride:confirmed` carries only `{rideId}` (`socket_handler.ts:789`), and
`GET /rides/active/driver` returns the raw `Ride` row with no contact data at all
(`ride_routes.ts:97`) — which is why a driver whose app restarts mid-ride **already** loses the call
button today. The privacy fix therefore has to *add* an assignment-time contact channel before it can
*remove* the offer-time one. Sequencing in §7.

---

# 1. RECONCILED PRODUCT ARCHITECTURE

## 1.1 The four rules that hold the design together

1. **Direct dispatch is authoritative and unchanged.** The orchestrator, its 2-round / 110 s budget,
   the Redis driver reservation and the conditional `searching → accepted` UPDATE are untouched.
2. **The dispatcher assigns; they never advance the lifecycle.** No dispatcher endpoint exists that can
   set a ride to arrived, started or completed. This is structural, not policy.
3. **`RideStatus` gains no new values.** Park state lives in `ParkRideClaim` / `ParkDriverAssignment`.
   Every existing conditional UPDATE, sweeper query and eligibility filter keeps working unmodified.
4. **Park state is durable and distributed** — Postgres for truth, Redis for atomic locks and TTLs,
   never an in-memory `Map`.

## 1.2 End-to-end shape

```
                            ride:request
                                 │
        ┌────────────────────────┴─────────────────────────┐
        │  PHASE 1 — DIRECT DISPATCH (unchanged, ≤110 s)   │
        │  round 1: 2 / 3.5 / 5 km   round 2: 5 / 6.5 km   │
        └───────┬──────────────────────────────┬───────────┘
                │                              │
      at t≈75 s │ (final direct tier opens)    │ driver accepts
                ▼                              ▼
        PARK PRE-ALERT  ─────────────►   status = accepted   [DONE]
        park sees the request,            park pre-alert invalidated
        may pre-select a driver,
        MAY NOT assign yet
                │
                │ direct dispatch formally fails
                ▼
        PARK CLAIM WINDOW (25 s)  ──── unclaimed ───► next park, else failed
                │ claimed
                ▼
        DRIVER SELECTION (45 s)   ──── no assign ──► release claim → failed
                │ badge scan → photo confirm → assign
                ▼
        ┌───────────────────────────────────────────────────┐
        │  conditional UPDATE: searching → accepted         │
        │  (the SAME statement ride:accept uses)            │
        └───────┬───────────────────────────┬───────────────┘
                │ driverDeviceMode='app'    │ driverDeviceMode='park_managed'
                ▼                           ▼
        driver app confirms          passenger app becomes
        → normal lifecycle,          the lifecycle witness
          normal GPS gates           (§2, §4)
```

## 1.3 Actor authority matrix

| Capability | Direct driver | Park + app driver | Park + no-phone driver | Dispatcher | Passenger |
|---|---|---|---|---|---|
| Accept / be assigned | self | dispatcher assigns, driver confirms | dispatcher assigns | assign only | — |
| Departed park | — | optional marker | **dispatcher marker** (evidence only) | ✅ | — |
| Arrived at pickup | ✅ (GPS-gated) | ✅ (GPS-gated) | — | ❌ | ✅ one-tap |
| Start trip | ✅ (GPS-gated) | ✅ (GPS-gated) | — | ❌ | ✅ one-tap |
| Complete trip | ✅ (GPS-gated) | ✅ (GPS-gated) | — | ❌ | ✅ one-tap |
| Report issue / no-show | ✅ | ✅ | — | ✅ | ✅ |
| Request cancellation | ✅ | ✅ | — | ✅ (request only) | ✅ |
| Move money | ❌ | ❌ | ❌ | ❌ | ❌ |

A dispatcher marker (`departed park`, `driver returned`, `passenger unreachable`) **never changes
`Ride.status`**. It writes a `ParkAuditEvent` and contributes to the evidence grade. That is its only power.

---

# 2. REVISED NO-SMARTPHONE LIFECYCLE

## 2.1 The passenger journey (unchanged in shape)

> choose pickup → choose destination → request Keke → meet the driver → ride

Two one-tap confirmations are added, at the two moments the passenger is already looking at the phone:

```
   ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
   │  [photo]  Emeka Okafor               │    │  Have you reached your destination?  │
   │           Unit 214 · ENU-472-KJA     │    │                                      │
   │           Yellow Keke · ★ 4.8        │    │  ┌────────────────────────────────┐  │
   │                                      │    │  │      Yes, complete ride        │  │
   │  Is your Keke here?                  │    │  └────────────────────────────────┘  │
   │  ┌────────────────────────────────┐  │    │  ┌────────────────────────────────┐  │
   │  │      Yes, start my ride        │  │    │  │           Not yet              │  │
   │  └────────────────────────────────┘  │    │  └────────────────────────────────┘  │
   │  ┌────────────┐  ┌────────────────┐  │    │                                      │
   │  │  Not yet   │  │   📞  Call     │  │    │  Fare ₦1,500 · Cash                  │
   │  └────────────┘  └────────────────┘  │    │                                      │
   └──────────────────────────────────────┘    └──────────────────────────────────────┘
```

No code to remember, speak, type or scan in the normal flow. Identification is **visual**: photo, name,
unit number, plate, colour. That is how people already identify a Keke in a park.

## 2.2 The `pickupCode` — what it becomes

It stays **exactly as it is today**: a passive "Ride code: 7K2P" strip on the passenger card
(`booking_sheet.dart:1702`) and on the driver HUD (`trip_operation_hud.dart:100`), generated at request
time and **never validated by the backend**.

It is promoted to the **fallback confirmation** for the exception paths in §2.5 only. Because it
already exists on both surfaces, this needs no new field, no new generation logic and no new UI in the
normal flow. A dispatcher can be given it only when support opens an assisted-recovery flow.

## 2.3 Passive supporting evidence

Evidence **grades** a confirmation. It never replaces one, and no single signal is sufficient.

| Signal | Source | Available today? | Strength |
|---|---|---|---|
| Passenger tap | passenger app | new | **necessary** — nothing proceeds without it |
| Passenger fix at confirmation | passenger app, sent with the tap | precedent exists (`ride:end_early` already accepts `lat/lng`; `passengerConsentLat/Lng` columns exist) | strong when accurate + fresh |
| Passenger displacement after start | sampled passenger fixes (new, §2.7) | no | strong — the direct analogue of `movementDistanceM` |
| Destination proximity at completion | sampled passenger fix | no | strong |
| Elapsed vs plausible travel time | `KEKE_METRES_PER_MINUTE = 230` already in `stale_ride_config.ts` | **yes** | moderate |
| Dispatcher "departed park" marker | dispatcher device | new | moderate, and **never self-sufficient** (single-party) |
| Park device location at assignment | dispatcher device | new | weak — proves the dispatcher was on-site, nothing about the trip |
| Call activity between the parties | `ride:activity` type `call_attempt` already exists | **yes** | moderate |
| Passenger socket presence | `RideActivityService.setPresenceProbe` already exists | **yes** | weak (liveness only) |
| Time since assignment | server | yes | weak |

The codebase already draws exactly this distinction — `ActivityKind.LIVENESS` vs `APPROACH` vs `INTENT`
in `stale_ride_config.ts`, with the comment *"An open app is not a driver who is coming."* The same
discipline applies here: **liveness never proves a trip.**

## 2.4 Start confidence levels

```ts
enum RideStartConfidence {
  VERIFIED_DRIVER_APP            = 'verified_driver_app',
  VERIFIED_PASSENGER_TAP         = 'verified_passenger_tap',
  PROVISIONAL_LOCATION_EVIDENCE  = 'provisional_location_evidence',
  FALLBACK_CODE_CONFIRMED        = 'fallback_code_confirmed',
  SUPPORT_OVERRIDE               = 'support_override',
}
```

| Level | Produced by | Settlement treatment |
|---|---|---|
| `VERIFIED_DRIVER_APP` | driver app `ride:start`, GPS gate passed — today's direct path | auto-settle |
| `VERIFIED_PASSENGER_TAP` | passenger tap **+** fresh passenger fix within `pickupArrivalRadiusM` (150 m) of the pickup pin | auto-settle |
| `PROVISIONAL_LOCATION_EVIDENCE` | passenger tap, but the fix is stale, absent or out of radius, with ≥2 corroborating passive signals | settle, **flag** `suspicious` |
| `FALLBACK_CODE_CONFIRMED` | passenger tap + `pickupCode` matched, used when location is unavailable | settle, flag |
| `SUPPORT_OVERRIDE` | a named support agent, with a reason | **hold**, always reviewed |

Symmetrically, `RideCompletionConfidence` with the same five members.

**Every ride start records:** `initiatedBy` · `confirmationMethod` · `confidenceLevel` ·
`passengerResponse` · evidence timestamps · `parkId` · `dispatcherId` · `driverId` · `deviceId`.
Stored on `Ride` (a small denormalised set for reporting) and in full on `RideConfirmationEvent`.

**A dispatcher can never produce any of these levels.** There is no dispatcher-reachable path to a
started or completed ride, so "assign + start + complete by one actor" is impossible by construction.

## 2.5 Exception paths

| Situation | Behaviour |
|---|---|
| Passenger taps "Not yet" | Nothing changes. The existing coordination flow (reminders, two-sided cancellation, escalation) applies unmodified |
| Passenger location unavailable | Tap still works → `PROVISIONAL_LOCATION_EVIDENCE`; if passive corroboration is also thin, offer the `pickupCode` fallback → `FALLBACK_CODE_CONFIRMED` |
| Passenger app malfunction / very old build | Support-assisted recovery: agent confirms by phone, reads the `pickupCode`, records `SUPPORT_OVERRIDE`. Held for review |
| Passenger never confirms start | Existing stale machinery: `acceptedMinMinutes` (20) → prompts → two-sided decision. **Nothing auto-starts** |
| Passenger never confirms completion | Auto-complete at **30 min** past plausible arrival with `paymentHeld = true`, `reviewReason = 'park_ride_no_passenger_confirmation'` |
| Passenger disputes ("driver never came") | `RideDispute` opened; money held; admin resolves |
| Dispatcher reports "passenger unreachable" | Audit event + support ticket. Does **not** change ride status |
| Higher-risk assignment (new driver, prior flags, high fare) | `requireFallbackCode = true` on that ride — the code step is added *for that ride only* |

## 2.6 Dispatcher markers (the complete list)

`driver_assigned` · `driver_departed_park` · `assignment_issue` · `driver_returned_to_park` ·
`passenger_unreachable` · `support_needed`

All write `ParkAuditEvent`. None writes `Ride.status`.

## 2.7 New data collection — passenger location sampling

Park `park_managed` rides need a passenger-side analogue of the driver GPS trail, or completion
integrity has nothing to measure.

**Recommendation: sampled, not continuous.** A fix at each confirmation tap, plus one every 60 s
**only** while a `park_managed` ride is active, stopping at completion. Not a background service; only
while the ride is live.

This is **new personal data collection** and requires: an in-app disclosure at request time for park
rides, a privacy-policy update (both apps already carry a policy screen —
`driver_profile_screen.dart:1152`, `profile_screen.dart:539`), and a retention limit (raw samples
purged at 90 days; derived aggregates — total displacement, destination distance — retained with the
ride). **Product and legal must approve before Phase 7 is built.**

---

# 3. PASSENGER-FRICTION DECISION

**Decision: no mandatory code, no mandatory scan, no mandatory speech. Two one-tap confirmations, and
they are the only additions to the passenger journey.**

| | Phase 0 proposal | Phase 0.5 decision |
|---|---|---|
| Boarding | passenger reads the code, driver confirms it | passenger taps "Yes, start my ride" |
| Completion | passenger taps + confirms amount | passenger taps "Yes, complete ride" |
| Code role | mandatory verification step | passive display; fallback only |
| Extra taps vs a direct ride | 2 taps + 1 verbal exchange | **2 taps** |

Rationale: the passenger is a customer, not an operator. A code exchange is the kind of step that works
in a demo and fails in the rain, in traffic, in a shared Keke, with a passenger holding shopping. The
security it appears to buy is also weaker than it looks — a code shared over a phone call proves
nothing about physical presence, whereas a tap plus a location fix plus corroborating passive evidence
does.

The gap this leaves is honest and bounded: a passenger who *deliberately* colludes with a driver can
confirm a trip that did not happen. That is out of reach of any client-side mechanism, code or no code,
and is addressed by pattern detection (§9 of the discovery report), not by friction.

---

# 4. LIVE-GPS COMPATIBILITY DESIGN

Per transition, per driver mode. **No fake driver GPS is ever synthesised.**

## 4.1 Smartphone driver (park-assigned or direct) — unchanged

| Transition | Mechanism | Change |
|---|---|---|
| `ride:arrived` | `evaluateProximityGate` 150 m, driver GPS | **none** |
| `ride:start` | `evaluateProximityGate` 150 m, driver GPS | **none** |
| `ride:complete` | `evaluateCompletion` — destination 300 m, movement 100 m, duration 60 s | **none** |
| Live tracking | `driver:location_update` off the heartbeat | **none** |

After a park handoff, the dispatcher's lifecycle powers are already nil, so there is nothing to revoke.
The dispatcher device flips to a read-only "Confirmed — driver has the ride" state.

## 4.2 No-smartphone driver — the substitution table

| Transition | Driver-GPS mechanism (unavailable) | Replacement | Verifiability |
|---|---|---|---|
| Departed park | — | dispatcher marker + park coordinates + timestamp | **provisional** — single-party, evidence only |
| Arrived at pickup | 150 m geofence on driver GPS | passenger tap; passenger fix vs pickup pin; elapsed time vs `parkDistance ÷ 230 m/min` | **verifiable** when the passenger fix is fresh and in radius |
| Passenger boarded | — | folded into the start tap — one action, not two | **verifiable** |
| Ride started | 150 m geofence on driver GPS | same tap; `startLat/startLng` recorded from the **passenger** fix | **verifiable** / provisional |
| Ride completed | destination 300 m + movement 100 m + duration 60 s on driver GPS | passenger tap; passenger displacement from sampled fixes; destination proximity; duration | **verifiable** / provisional |
| Live tracking | continuous driver GPS | **not supported.** Park origin + one-shot ETA + call button | **not supported — stated honestly** |

## 4.3 What is verifiable, provisional, reviewed, and unsupported

**Fully verifiable** (auto-settle): passenger tap + fresh in-radius passenger fix at both ends +
plausible duration + real displacement. This is a genuine analogue of the driver-GPS path and is
expected to be the large majority of park rides in a town with usable GPS.

**Provisionally inferred** (settle + flag, or hold): tap present, location weak or absent, corroborated
by ≥2 passive signals. Flagged rides feed the existing admin held-for-review queue.

**Support-reviewed** (hold, always): no passenger confirmation within 30 min; disputes; support
overrides; any ride where the dispatcher reported an issue.

**Not safely supported — do not attempt:** live driver position; driver-side proof of anything;
automatic completion with no passenger confirmation and no support review; any dispatcher-only trip
record. If a ride reaches the end of the evidence ladder with nothing, it completes **held**, and a
human reconciles it. That is the honest manual workflow the direction asked for, and it reuses the
`paymentHeld` → admin `release` / `void` path that already exists (`admin_routes.ts:686,719`).

## 4.4 Passenger-side integrity thresholds

The same constants, read from the passenger trail instead of the driver trail — `PICKUP_ARRIVAL_RADIUS_METERS`
(150), `DESTINATION_COMPLETION_RADIUS_METERS` (300), `MIN_TRIP_MOVEMENT_METERS` (100),
`MIN_TRIP_DURATION_SECONDS` (60). New reason codes, mirroring the existing vocabulary:
`no_passenger_location_at_start` · `passenger_far_from_pickup_at_start` ·
`no_passenger_location_at_completion` · `no_meaningful_passenger_movement` ·
`park_ride_no_passenger_confirmation`.

**`evaluateCompletion` is not modified.** A sibling `evaluatePassengerCompletion` is added alongside it,
sharing the same config object. The existing function stays untouched so no direct ride's behaviour can
shift by accident.

---

# 5. SEARCH-TIME RECOMMENDATION

## 5.1 Recommendation: Option B

**Park pre-alert during the final direct tier; park ownership only after direct dispatch formally fails.**

| Option | Verdict |
|---|---|
| A — strictly sequential | Safe, but pays the dispatcher's cold-start latency in full, on the critical path |
| **B — pre-alert, ownership after failure** | ✅ **Recommended.** Removes ~30–40 s of human reaction time from the critical path while direct priority remains absolute |
| C — parallel preparation with park able to prepare a driver | Folded into B: pre-alert *is* permission to prepare. What C adds beyond that is park ownership racing direct dispatch, which is the risk we are avoiding |
| D — location-specific strategy | Right long-term answer, wrong first move. The `Park` model carries `dispatchStrategy` from Phase 2 so D is a config change later, not a rewrite |

## 5.2 What pre-alert does and does not permit

| Dispatcher can, during pre-alert | Dispatcher cannot, during pre-alert |
|---|---|
| See: pickup area, destination area, fare, payment mode, distance from park | See any passenger identity or contact data |
| See the current queue and pre-select a likely driver | Claim the ride |
| Walk to the driver and ask if they will take it | Scan a badge |
| — | Assign — the endpoint returns `409 PARK_NOT_CLAIMABLE_YET` |

The pre-alert is **advisory**. If a direct driver accepts, the pre-alert is invalidated
(`park:prealert_invalidated` to the park room) and the dispatcher sees "Taken by a nearby driver."

## 5.3 Timings

| Phase | Window | Notes |
|---|---|---|
| Direct dispatch | **110 s** | Unchanged. `DISPATCH_MAX_SEARCH_LIFETIME_MS` |
| Park pre-alert fires | **t ≈ 75 s** | At the opening of round 2's final tier. Config: `PARK_PREALERT_AT_MS` |
| Park claim window | **25 s** | A confirmation, not a cold decision — the dispatcher has already had ~35 s |
| Park driver assignment | **45 s** | Badge scan + photo confirm is a ~10 s operation once the driver is identified |
| **Total ceiling** | **180 s (3 min)** | `110 + 25 + 45` |
| Target p50, park path | **≤ 150 s** | Pre-alert should make most claims near-instant |
| Second park fallback | **not in pilot 1** | Would push the ceiling to 250 s. Excluded (§12) |

## 5.4 Making 180 s safe on apps already in the field

`110 → 180 s` crosses the passenger app's 150 s watchdog (F1). Two mechanisms, both required:

1. **Now, no app change:** at the start of the park phase the backend emits
   `ride:dispatch_round { dispatchRound: 3, totalRounds: 3, reason: 'park_fallback' }`. Existing builds
   re-arm the watchdog (`booking_controller.dart:154`) and render **"Still searching nearby…"** — honest,
   and the round number is never displayed (`booking_notice.dart:250`).
2. **New builds:** raise `_searchWatchdogTimeout` to **210 s** and add park-specific copy —
   *"Checking a nearby Keke park…"* then *"A driver is being assigned…"* — driven by a new
   `ride:park_state` event that old builds ignore.

Mechanism 1 is the compatibility floor; mechanism 2 is the intended experience. **Both ship**, so park
fallback is never gated on app adoption.

## 5.5 Invariants under Option B

| Invariant | Mechanism |
|---|---|
| One authoritative ride ID | Park phases never insert a ride row |
| No duplicate assignment | Both paths end in the same conditional UPDATE; the loser gets `affected = 0` |
| Direct priority absolute | Claim acquisition is refused while the ride is inside the direct budget |
| Park cannot steal an accepted ride | The UPDATE's `status = 'searching'` predicate fails the instant a direct driver wins |
| No passenger contact leak during preparation | Pre-alert payload carries area-level geography and no identity (§7) |
| Honest passenger messaging | Round-transition copy now; park-specific copy in new builds |

---

# 6. PARK CLAIM AND ASSIGNMENT ATOMICITY

## 6.1 States

Naming follows the codebase style — a `SCREAMING_CASE` TypeScript enum with `snake_case` string values,
as in `RideStatus` and `RideDelayState`.

```ts
export enum ParkClaimState {
  PARK_ELIGIBLE            = 'park_eligible',             // computed, not persisted until offered
  PARK_OFFERED             = 'park_offered',              // pre-alert or formal offer live
  PARK_CLAIMED             = 'park_claimed',              // a dispatcher owns it
  DRIVER_SELECTION_PENDING = 'driver_selection_pending',  // scanning / entering a code
  DRIVER_ASSIGNED          = 'driver_assigned',           // ride flipped to accepted
  DRIVER_CONFIRMED         = 'driver_confirmed',          // app driver acknowledged
  PARK_RELEASED            = 'park_released',             // deadline missed / dispatcher released
  PARK_EXPIRED             = 'park_expired',              // offer window closed unclaimed
  PARK_CANCELLED           = 'park_cancelled',            // passenger cancelled / direct driver won
}
```

## 6.2 Durable truth + fast lock

**Postgres — `ParkRideClaim`** is the record of what happened: `claimId`, `rideId`, `parkId`, `state`,
`attemptNumber`, `offeredAt`, `offerExpiresAt`, `claimedAt`, `claimedByStaffId`, `deviceId`, `shiftId`,
`assignmentDeadlineAt`, `releasedAt`, `releaseReason`. Append-only in spirit: a released claim is never
reused; a retry creates `attemptNumber + 1`.

**Redis — the lock** that makes concurrency safe:

```
park:claim:<rideId>        = <parkId>    SET NX EX 25   → one owner at a time
park:assign:<rideId>       = <claimId>   SET NX EX 45   → serialises assignment attempts
park:prealert:<rideId>     = <parkId>    SET    EX 60   → advisory, no ownership
park:idem:<idempotencyKey> = <result>    SET NX EX 300  → idempotent retry
```

Release is **ownership-checked**, reusing the Lua script already in `DispatchService`
(`RELEASE_IF_OWNER`, `dispatch_service.ts:197`) — one ride can never delete a lock another ride has
since acquired. Park keys are namespaced `park:*` and never touch `driver:reserved:*`.

## 6.3 Claim acquisition

```
POST /dispatcher/rides/:rideId/claim     { deviceId, idempotencyKey }

  1. staff auth + shift open + device bound + park active            → else 403
  2. ride still `searching` and outside the direct budget            → else 409 PARK_NOT_CLAIMABLE_YET
  3. SET park:claim:<rideId> <parkId> NX EX 25                       → else 409 PARK_ALREADY_CLAIMED
  4. INSERT ParkRideClaim (PARK_CLAIMED, assignmentDeadlineAt = now + 45s)
  5. DispatchEvent PARK_CLAIM_ACQUIRED  +  ParkAuditEvent
  6. → 200 { claimId, assignmentDeadlineAt, queue }
```

Step 3 before step 4: the Redis `NX` is the arbiter, and the row records the winner. A crash between
them leaves a lock with no row, which the TTL clears in 25 s.

## 6.4 Assignment — the exact logic

```
POST /dispatcher/claims/:claimId/assign
     { badgePayload | shortCode, photoConfirmed: true, deviceId, idempotencyKey }
```

```
 1. idempotency: SET park:idem:<key> NX EX 300 → if it exists, return the stored result verbatim
 2. verify: staff · shift · device · park · claim owned by this park · deadline not passed
 3. resolve driver: HMAC-verify the QR, or look up the short code (rate-limited)
 4. badge active · driver approved · checked into THIS park · photoConfirmed === true
 5. DriverEligibilityService.filter([driverId], { isCash })   ← the SAME filter direct dispatch uses
 6. BEGIN TRANSACTION
      INSERT ParkDriverAssignment (state = pending_driver_confirm | assigned,
                                   idempotencyKey UNIQUE)
      UPDATE ride
         SET "driverId" = :driverId, status = 'accepted',
             "dispatchMode" = 'park', "parkId" = :parkId,
             "parkAssignmentId" = :assignmentId
       WHERE "rideId" = :rideId AND status = 'searching'      ← THE SOLE ARBITER
      -- affected = 0 → ROLLBACK, mark assignment `superseded`
      UPDATE park_ride_claim SET state = 'driver_assigned'
    COMMIT
 7. Redis: release park:claim (ownership-checked); release the ride's direct reservations
 8. emit ride:assigned (passenger) · ride:park_assignment (app driver) · admin update
 9. DispatchEvent PARK_DRIVER_ASSIGNED + ParkAuditEvent
```

**Why one driver can never be assigned twice for one ride:** step 6's predicate is
`status = 'searching'`. A direct `ride:accept` executing concurrently runs the identical statement
(`socket_handler.ts:734`). Postgres row-level locking serialises them; exactly one sees `affected = 1`.
The loser — whichever it is — is told the ride was taken. No new race is introduced because **no new
arbiter is introduced**.

Note the improvement over the direct path: here the assignment row and the ride UPDATE are in **one
transaction**, so a crash cannot leave an assignment record without a ride or vice versa.

## 6.5 Interactions

| Event | Handling |
|---|---|
| Direct driver accepts during a park claim | Park UPDATE returns `affected = 0` → assignment `superseded`; claim → `PARK_CANCELLED`; dispatcher sees "Taken by a nearby driver". **Correctness is automatic; the message is UX** |
| Passenger cancels | Existing cancel path additionally releases `park:claim:*` and sets the claim `PARK_CANCELLED` |
| Assignment deadline passes | Sweeper releases the claim → `PARK_RELEASED` → ride fails (no second park in pilot 1) |
| Dispatcher device dies mid-claim | Redis TTL (25 s / 45 s) releases it; the durable row records the abandonment |
| Stale claim recovery | A new pass in `StaleRideSweeper` over claims in `PARK_CLAIMED` / `DRIVER_SELECTION_PENDING` past their deadline. Same batch/dry-run/logging conventions as the existing passes |
| Retry after a flaky response | `idempotencyKey` returns the identical result; no second assignment |
| Backend restart mid-claim | Claim survives (Postgres + Redis). **This is the concrete payoff of rule 4** — the direct dispatch run in the in-memory `Map` would not survive, and does not need to |

---

# 7. PASSENGER CONTACT PRIVACY FIX

Standalone defect, fixed as **Phase 0.9** — before Park Dispatch touches the dispatch path.

## 7.1 Target state

| Recipient | Before assignment | After assignment | After ride ends |
|---|---|---|---|
| Candidate drivers being rung | **nothing** — no name, no phone | n/a | n/a |
| Assigned driver | n/a | first name + dialable number | revoked at terminal + 2 h |
| Dispatcher | **nothing** | **nothing by default**; `park:reveal_contact` for a live incident only, audited, one ride, 30 min | revoked |
| Park roster / other drivers | never | never | never |
| Admin | masked (`maskPhone` already exists, `dispatch_monitor_query_service.ts:370`) | masked; reveal behind `monitor:reveal_contact`, already audited (`admin_routes.ts:98`) | masked |

Offer payload after the fix: pickup/destination address, distance, fare, payment mode, `dispatchRound`.
No `passengerPhone`, no `passengerName`.

## 7.2 Sequencing — this cannot be one release

Removing `passengerPhone` from the offer in a single change would silently remove the in-ride call
button from **every driver phone currently in the field** (F2), because the driver app builds its
`TripRequest` from the offer payload and never re-reads contact data.

```
  Release 1  (backend, additive — nothing removed)
     ride:confirmed  gains { passengerFirstName, passengerPhone }
     GET /rides/active/driver  gains the same
     → fixes the EXISTING bug where an app restart mid-ride loses the call button

  Release 2  (driver app)
     read contact from ride:confirmed and from active-ride recovery; merge into activeRequest
     → app now works whether or not the offer carries a phone

  ── wait for adoption (monitor appVersion on ride:request / DispatchEvent.detail.appVersion,
      which the backend already records — socket_handler.ts:538) ──

  Release 3  (backend, the actual fix)
     remove passengerPhone + passengerName from buildOfferPayload
     add ContactRevealEvent auditing
```

Release 1 is worth shipping on its own merits regardless of Park Dispatch.

## 7.3 Reveal auditing and expiry

`ContactRevealEvent { id, rideId, revealedToStaffId | driverId, role, fields[], reason, grantedAt,
expiresAt, deviceId }`. Reveals are **time-boxed** (assigned driver: ride terminal + 2 h; dispatcher:
30 min) and the dispatcher app must not cache a revealed number beyond its expiry.

**Deferred, deliberately:** a masked-number call relay (Africa's Talking / Twilio) is the right end
state — neither party ever sees the other's real number. It needs a telephony vendor, per-minute cost
and a number pool, so it is a post-pilot item. v1 is controlled, audited, expiring reveal, and this
tradeoff is stated rather than hidden.

---

# 8. ADMIN / STAFF IDENTITY PREREQUISITE (Phase 1)

**No dispatcher work may begin before this lands.** The current model — up to four environment API keys
mapped to role labels, `AuditLog.adminId` storing a role rather than a person, and both
`attachAdminIdentity` and `requirePermission` **defaulting to `superadmin`** — cannot answer "which
human issued this badge".

## 8.1 `StaffUser`, not `User`

Revising R2 from Phase 0: staff go in their **own table**, not the customer `User` table.

Reasons: staff need MFA, device binding, shifts, suspension and credential rotation that customers do
not; a staff token must be structurally unusable on customer endpoints (`aud: 'staff'` in the JWT); and
a bug in customer auth must not be able to reach staff privileges. The cost is duplicating a little
password/OTP logic — `AuthService` is already reusable for hashing, comparison and token generation.

```
StaffUser
  staffId (uuid PK) · email (unique) · passwordHash · firstName · lastName
  phone (REQUIRED) · photoUrl
  status: active | suspended | terminated
  mfaSecret (nullable) · mfaEnrolledAt
  passwordChangedAt · mustChangePassword · lastLoginAt · failedLoginCount · lockedUntil
  createdByStaffId · createdAt · updatedAt

StaffRoleAssignment
  id · staffId · role · parkId (nullable — scopes park roles to one park)
  grantedByStaffId · grantedAt · revokedAt

StaffSession
  sessionId · staffId · deviceId (nullable) · issuedAt · expiresAt
  revokedAt · revokedReason · ipAddress · userAgent
```

## 8.2 Roles and permissions

| Role | Scope | Key permissions |
|---|---|---|
| `superadmin` | global | everything, including staff management |
| `operations` | global | parks, devices, roster, monitoring, badge issuance |
| `support` | global | live rides, contact reveal, disputes, support override |
| `finance` | global | payouts, reconciliation, ledger reports, reversals |
| `park_supervisor` | one park | dispatcher shifts, override review, cashier approval, incidents |
| `park_dispatcher` | one park | claim, assign, driver lookup, check-in, markers, incidents |
| `park_cashier` | one park | record cash collection, print/SMS receipts |

New permission strings extend the existing `AdminPermission` union rather than replacing it:
`park:manage` · `park:claim_ride` · `park:assign_driver` · `park:lookup_driver` · `park:checkin_driver`
· `park:reveal_contact` · `badge:issue` · `badge:revoke` · `staff:manage` · `cash:collect` ·
`cash:reconcile` · `finance:reverse`.

## 8.3 Authentication factors

| Role | Factors |
|---|---|
| `superadmin`, `finance`, `park_supervisor` | password + **TOTP MFA** |
| `operations`, `support` | password + TOTP MFA |
| `park_dispatcher`, `park_cashier` | password + **bound device credential** as the second factor |

TOTP on a shared kiosk device is poor security theatre — the token lives on the same device as the
session. A device credential the admin can revoke remotely is the stronger and more practical second
factor for park staff.

Other required controls: one active session per dispatcher (a second login revokes the first and is
logged); 12-hour session expiry; forced password rotation every 90 days for global roles; immediate
session revocation on suspension; and **`AuditLog.adminId` migrated to a real `staffId`** with the
existing `SYSTEM_ADMIN` rows preserved and clearly labelled as pre-migration.

## 8.4 Backward compatibility

`ADMIN_API_KEY` must keep working during the transition — the admin dashboard is a live operational
tool. Plan: `StaffUser` login issues a staff JWT; `adminAuth` accepts **either** a valid staff JWT or a
configured API key; API-key requests are attributed to a synthetic `staff:legacy_<role>` id that is
visibly marked in the audit log. The keys are removed once the dashboard has migrated —
and **before any park role is granted**, since a park role must never be reachable by a shared key.

---

# 9. QR AND SIX-DIGIT SPECIFICATION (final)

## 9.1 Confirmed, with one refinement

Phase 0's design stands. One change: the QR payload gains a **checksum-friendly separator and a key
version** so the signing key can be rotated without reprinting badges signed under the old key.

```
KR1|<keyVersion>|<badgeSerial>|<driverPublicId>|<issuedEpochDays>|<sig>

sig = base32( HMAC_SHA256(BADGE_KEY[keyVersion],
                          "KR1|<keyVersion>|<badgeSerial>|<driverPublicId>|<issuedEpochDays>")[0..9] )
```

Opaque · signed · serialised · non-PII · revocable · safe if photographed · verifiable offline for the
signature, **online for validity** · useless as a credential. Truncated to 80 bits — unforgeable in
practice, small enough for a low-density QR that still scans off a scuffed laminate at error-correction
level Q.

`driverPublicId` is a new opaque identifier. The internal `User.id` uuid is never printed.

## 9.2 Six-digit code

Identifies a badge for assignment. Rate-limited **per device** (5 failures / 10 min → 15 min lockout),
**per park** (20 failures / hour → supervisor alert) and **per code** (3 failures → that code is frozen
until an admin clears it). Every failed lookup is a `ParkAuditEvent`, never a silent 404. Unique across
`active` badges; never reused after revocation. Authorises no financial action, ever.

## 9.3 Both paths converge on the same screen

Scan or type → **full-screen photo + name + unit number + plate** → the dispatcher must tap
**"This is the person in front of me"** → only then does the assign call fire. This single screen is
what defeats badge sharing, and it costs about a second.

## 9.4 Lifecycle

| Event | Handling |
|---|---|
| Issue | `badge:issue` permission; generates serial, `driverPublicId`, short code; renders a printable PDF; requires the driver to be `approved` with a `photoUrl` |
| Activate | Issued badges start `pending_activation`; a dispatcher scans it once at the park to activate. Proves the physical card reached the right person |
| Replace | Issuing a new badge auto-revokes the previous one; reason recorded (`lost` / `damaged` / `stolen` / `reissue`) |
| Lost / stolen | Immediate revoke; assignment refused with a dispatcher-visible reason; stolen badges additionally alert the park |
| Copied QR | Not a defeat condition — the badge is not a credential. Photo-confirm, shift, device and park scope all still apply |
| Damaged | Six-digit fallback; reissue |
| Suspended driver | `DriverEligibilityService` refuses; the dispatcher sees "Suspended — contact operations" |
| Wrong vehicle | Plate is on the confirm screen and on the passenger card; mismatch is a reportable incident |
| Offline scan | Signature verifies locally so the dispatcher gets instant "valid badge" feedback, but assignment **requires** the server. UI shows "Waiting for network…", never "Assigned" |
| Audit | Every scan, every failed lookup, every assignment, with `staffId` · `parkId` · `deviceId` · `shiftId` · `badgeSerial` |

## 9.5 Static vs rotating QR

**Static signed QR is correct for the pilot, and for a long time after.** A rotating QR requires a
powered display on the driver's side — which is precisely what a no-smartphone driver does not have.
Rotation would therefore only ever apply to smartphone drivers, who do not need badges.

Rotation becomes necessary only if the *photo-confirm control fails in practice* — i.e. if audits show
dispatchers confirming identity without looking. The honest response to that is a personnel and
monitoring problem, not a cryptography problem. Trigger to revisit: >2 % of assignments showing
photo-confirm times under 2 seconds, or any confirmed badge-sharing incident.

---

# 10. WALLET, CASH-IN AND COMMISSION ARCHITECTURE

## 10.1 Confirmed direction

Hybrid, which is what `_postCashRideFinancials` already implements: commission posted automatically,
deducted from `driverAvailableBalance`, shortfall → `driverCommissionDebt`, blocked at ₦2,000 for cash
rides. A driver needs no smartphone to own a wallet — the wallet is a server-side row keyed on `userId`.

Three additions, none of which rewrites the ledger.

## 10.2 The cash-in path

```
 Driver pays cash to the CASHIER at the park
        │
        ▼
 Cashier records: driverId (badge scan) · amount · method · deviceId
        │
        ▼
 CashCollection (pending_reconciliation)
        │
        ├─ ledger posts IMMEDIATELY via WalletService.mutateBalance
        │     TOPUP → driverAvailableBalance  (then existing debt recovery applies)
        │     → driver is unblocked and back on the road within seconds
        │
        ├─ receipt: on-screen reference + SMS to the driver's phone
        │
        └─ cashier float += amount   (tracked, capped)
        │
        ▼
 End of shift: cashier declares cash on hand → supervisor counts → variance recorded
        │
        ▼
 Bank deposit → finance matches deposit to the shift's collections
        │
        ▼
 CashCollection → reconciled
```

**Debt relief is immediate; reconciliation is deferred.** The alternative — holding relief until a bank
deposit clears — leaves a driver idle for a day and kills adoption. The risk is bounded by the float
cap, the daily count and the variance record, not by delaying the driver.

## 10.3 Controls

| Control | Design |
|---|---|
| Float cap | Per-cashier `maxOpenFloat` (pilot: **₦30,000**). At the cap, further collections require supervisor approval |
| Two-stage | `pending_reconciliation` → `reconciled`; ageing float alerts at 24 h and 48 h |
| Receipt | Reference `KR-<park>-<shift>-<seq>`; SMS to the driver's phone (**a working phone is mandatory for a park-managed driver**) |
| Reversal | A **compensating ledger entry**, never an update. Requires `finance:reverse` + supervisor approval + reason. If the credit is already spent, the reversal creates debt |
| Mistaken credit | Same reversal path, reason `mistaken_credit`, driver notified by SMS |
| Cash shortage | Recorded as a `CashVariance` against the cashier and the shift; repeated variance suspends the cashier |
| Daily settlement | Per-shift declaration + supervisor count + deposit slip reference. No shift closes with unreconciled cash and no explanation |
| Tamper resistance | `LedgerEntry` remains append-only with `balanceBefore`/`balanceAfter` on every row. **No code path may write `Wallet` directly** — a code-review rule and a test that asserts `WalletService` is the only writer |
| Park-level reporting | Collections, commission accrued, outstanding debt, float age, variance — per park, per shift, per cashier |
| Central finance | Daily reconciliation report; per-park liability; unreconciled float ageing |

## 10.4 Bank transfer as an alternative to cash

A driver who can transfer should. `method = 'transfer'` with a reference, verified against the account
before the credit posts. This scales better than cash and reduces float — but it cannot be the only
path, because the drivers this feature exists for are the ones least likely to have a bank app.

## 10.5 Dispatcher-as-cashier: recommendation

**Recommendation: separate the roles at the pilot.**

The pilot exists to find out whether the controls work. Collapsing assignment authority and cash
custody into one person removes the separation of duties that is the primary control against the single
most likely fraud in the whole design — a park employee taking commission cash and not remitting it.
Testing a control by not implementing it produces no information. With 15–20 drivers, the second person
is a shift of a park supervisor, not a new hire.

**If genuinely unavoidable**, allow dual-role behind an explicit `allowDualRole` flag per park, with:
float capped at **₦10,000** (one third), **100 %** of collections reconciled daily by a remote
supervisor, and the arrangement recorded in the pilot risk register as a known, accepted weakness with
an end date.

**Never negotiable:** `park_dispatcher` and `park_cashier` are distinct roles with distinct permissions
even when one human holds both, so every action is still attributable to a capability. And the
dispatcher/cashier may **never** edit a wallet balance — all movement goes through `WalletService` and
leaves ledger rows.

## 10.6 Related fix

**Enforce or delete `DEBT_HARD_BLOCK` (₦5,000).** It is imported at `socket_handler.ts:30` and
referenced nowhere. Recommendation: enforce it — a driver above it cannot be assigned any ride, park or
direct — and surface it in the dispatcher UI with the amount owed so the dispatcher routes them to the
cashier instead of guessing.

---

# 11. PARK QUEUE AND FAIRNESS

## 11.1 Model: FIFO with automatic recommendation and reason-required override

```
 Driver arrives → dispatcher scans badge → CHECK-IN
        │
        ├─ approved? · badge active? · wallet eligible? · vehicle approved? · not on a ride?
        │      any fail → shown to the dispatcher with the reason, NOT queued
        ▼
 AVAILABLE QUEUE  (position = check-in order)
        │
        │  new request claimed
        ▼
 System RECOMMENDS the next eligible driver  ── dispatcher accepts (default, one tap)
        │                                     └─ dispatcher overrides → REASON REQUIRED
        ▼
 ASSIGNED → on trip → completion → re-check-in at the back of the queue
```

## 11.2 Override reasons (fixed list, free text only under `other`)

`driver_declined` · `driver_temporarily_unavailable` · `destination_unsuitable` ·
`insufficient_wallet` · `wrong_vehicle_type` · `vehicle_issue` · `driver_absent` ·
`passenger_request` · `emergency` · `other (free text, ≥15 chars)`

Queue-position rules: a driver skipped for a **system** reason (wallet, vehicle, suitability) keeps
their position. A driver who **declines** goes to the back — declining is a choice with a cost, or FIFO
becomes cherry-picking. Three declines in a shift → `temporarily_unavailable` until they re-check in.

## 11.3 Bias monitoring

- **Assignment concentration** — Gini coefficient over per-driver assignment counts, per dispatcher,
  per shift. Alert above a threshold calibrated during the pilot's first week.
- **Override rate** per dispatcher, with the reason breakdown. A dispatcher whose `other` rate exceeds
  10 % is reviewed.
- **Queue-position delta** — mean positions skipped per assignment. Should trend to ~0.
- **Pairing frequency** — a dispatcher/driver pair significantly above the park mean is flagged.

Every assignment records the recommended driver alongside the assigned one, so bias is measurable
rather than inferred. **A dispatcher is never free to select a friend without traceability**, because
"the system recommended someone else" is a stored fact on every override.

---

# 12. PILOT SCOPE

## 12.1 In scope

One park · 1–2 bound devices · named dispatcher shifts on real `StaffUser` accounts · one cashier or
supervisor-cashier per shift · 15–20 verified drivers (~5 with the app, ~12 park-managed) · printed QR
badges with six-digit fallback · direct-first with Option-B pre-alert and single-park fallback ·
**cash rides only** · server-side wallet, automatic commission, cashier cash-in · passenger one-tap
start and completion · fallback code on the exception path only · daily reconciliation · central
operations oversight.

**Staged rollout:** week 1 dry run (pre-alerts and claims logged, assignment disabled) → week 2
assignment live for the ~5 app drivers only (lowest risk — normal GPS lifecycle) → week 3 park-managed
drivers with settlement **disabled** (evidence logged, money held) → week 4 settlement enabled.

## 12.2 Explicitly excluded from Pilot 1

Offline assignment · NFC badges · USSD · voice IVR · **multiple-park fallback** · dispatcher or cashier
wallet editing · dynamic cash loans or credit extension · automated fraud scoring · rotating QR ·
hardware GPS trackers · wallet-paid park rides *(deferred to pilot 2 — cash is the actual use case, and
one payment path is enough to validate)* · masked-number call relay · park revenue sharing · polygon
geofences · park-first zones (Strategy C/D).

## 12.3 Success criteria and abort triggers

| Metric | Target |
|---|---|
| Park claim rate on offered requests | ≥ 70 % |
| Median time to claim (with pre-alert) | ≤ 12 s |
| Median time to driver assignment | ≤ 40 s |
| **Median total search time, park path** | **≤ 150 s** |
| Assignment → completion rate | ≥ 85 % |
| Rides auto-settling at `VERIFIED_PASSENGER_TAP` | ≥ 75 % |
| Rides held for review | ≤ 10 % |
| Commission recovery within 7 days | ≥ 90 % |
| Cash variance | ₦0 unexplained |
| Confirmed fraud incidents | 0 |
| Passenger rating, park rides | within 0.3 of the direct-dispatch average |

**Abort triggers:** any duplicate assignment of one ride to two drivers · any confirmed collusion ·
unreconciled float > ₦50,000 · held-for-review > 30 % · any regression in direct-dispatch acceptance
rate attributable to the park changes.

---

# 13. REVISED PHASED IMPLEMENTATION PLAN

Ten phases plus the standalone privacy fix. Each is independently shippable and independently
revertible. Every backend phase ships behind `PARK_DISPATCH_ENABLED` (default `false`) until Phase 10.

---

### Phase 0.9 — Passenger contact privacy fix *(standalone, no Park dependency)*

- **Objective** — stop broadcasting passenger phone numbers to every rung driver; fix the existing
  loss of the call button on app restart.
- **Files** — `socket_handler.ts` (`buildOfferPayload`, `ride:confirmed`), `ride_routes.ts`
  (`/active/driver`), new `models/ContactRevealEvent.ts`, `keke_driver` (`driver_controller.dart`,
  `trip_operation_hud.dart`).
- **Migrations** — `ContactRevealEvent` table.
- **APIs/events** — `ride:confirmed` gains `{passengerFirstName, passengerPhone}`;
  `GET /rides/active/driver` gains the same.
- **UI** — none visible; the driver call button becomes reliable.
- **Tests** — offer payload contains no contact data; assigned driver receives it; restart recovery
  restores it; reveal events written; expiry enforced.
- **Risk** — **medium**, entirely in the sequencing. Must ship as three releases (§7.2).
- **Rollback** — re-add the fields to `buildOfferPayload`; one-line revert.
- **Depends on** — nothing.
- **Acceptance** — no offer payload in production logs contains a phone number; ≥95 % of active driver
  installs on the contact-aware build before Release 3.

---

### Phase 1 — Staff identity and permissions

- **Objective** — a real, per-human staff identity that can answer "who did this".
- **Files** — `models/StaffUser.ts`, `StaffRoleAssignment.ts`, `StaffSession.ts`;
  `services/staff_auth_service.ts`; `middleware/staff_auth.ts`; rework `middleware/admin_permissions.ts`;
  `keke_admin` login.
- **Migrations** — three tables; `AuditLog.adminId` widened and backfilled to `staff:legacy_*`.
- **APIs** — `POST /staff/auth/login`, `/mfa/enroll`, `/mfa/verify`, `/logout`;
  `GET/POST /admin/staff` (CRUD), `POST /admin/staff/:id/suspend`.
- **UI** — admin login screen; staff management section.
- **Tests** — role→permission matrix; staff JWT rejected on customer endpoints and vice versa; MFA;
  lockout; session revocation on suspend; legacy API key still works and is attributed.
- **Risk** — **medium**. Touches admin auth, which is a live operational tool.
- **Rollback** — keep `ADMIN_API_KEY` accepted throughout; disabling the staff router restores today's
  behaviour exactly.
- **Depends on** — nothing.
- **Acceptance** — every admin action in the audit log carries a real `staffId`; a superadmin can
  create, suspend and rotate a staff account; API keys removed from the dashboard path.

---

### Phase 2 — Park, device, shift, badge and roster data model

- **Objective** — the entities exist and are queryable. **No behaviour.**
- **Files** — `models/Park.ts`, `ParkDevice.ts`, `DispatcherShift.ts`, `DriverBadge.ts`,
  `ParkDriverCheckIn.ts`, `ParkRideClaim.ts`, `ParkDriverAssignment.ts`, `ParkAuditEvent.ts`,
  `RideConfirmationEvent.ts`; nullable columns on `Ride` and `DriverProfile`.
- **Migrations** — additive DDL only; new nullable columns; `DispatchEventType` enum extended via
  `ALTER TYPE ... ADD VALUE IF NOT EXISTS` following `1746600000000`.
- **APIs/events** — none.
- **UI** — none.
- **Tests** — entity/migration round-trip; up/down; existing suite unaffected.
- **Risk** — **none**. Purely additive DDL.
- **Rollback** — `migration:revert`.
- **Depends on** — Phase 1 (foreign keys to `StaffUser`).
- **Acceptance** — migrations apply and revert cleanly on a production-shaped dump; the full existing
  test suite is green.

---

### Phase 3 — Admin park management and badge issuance

- **Objective** — operations can create a park, bind a device, roster drivers and print badges.
- **Files** — `routes/park_admin_routes.ts`, `services/badge_service.ts`, `park_service.ts`;
  `keke_admin` (parks, devices, roster, badges).
- **Migrations** — none.
- **APIs** — park CRUD; device bind/revoke/enrolment code; roster add/remove; badge
  issue/activate/revoke/replace; badge PDF.
- **UI** — admin: Parks, Devices, Roster, Badges.
- **Tests** — HMAC sign/verify round-trip; wrong key rejected; tampered payload rejected; revoked badge
  rejected; short-code uniqueness among active badges; badge PDF renders; permissions enforced.
- **Risk** — **none** to live dispatch — a new, isolated surface.
- **Rollback** — unmount the router.
- **Depends on** — Phases 1, 2.
- **Acceptance** — a park exists with coordinates and hours; a device is bound; 20 badges are issued
  and print legibly; a revoked badge fails verification.

---

### Phase 4 — Park claim and assignment backend

- **Objective** — the durable, atomic claim/assign engine, callable but not yet reachable by a
  dispatcher app.
- **Files** — `services/park_dispatch_service.ts`, `park_selection_service.ts`,
  `park_claim_service.ts`; `config/park_dispatch_config.ts`; `socket_handler.ts`
  (`finalizeUnsuccessfulDispatch` hook + pre-alert emit); `stale_ride_sweeper.ts` (claim recovery pass);
  `dispatch_event_projection.ts`.
- **Migrations** — none (Phase 2 covered them).
- **APIs/events** — `POST /dispatcher/rides/:rideId/claim`, `/claims/:id/assign`, `/claims/:id/release`;
  socket `park:prealert`, `park:offer`, `park:claim_invalidated`; `ride:dispatch_round` round 3.
- **UI** — none.
- **Tests** — **the heaviest suite in the project.** Concurrency: two parks claiming one ride; park vs
  direct accept racing the same UPDATE; idempotent retry; deadline expiry; passenger cancel mid-claim;
  backend restart mid-claim; direct-accept invalidating a pre-alert. Plus a full regression run of the
  existing dispatch suite proving `finalizeUnsuccessfulDispatch` is byte-identical when no park applies.
- **Risk** — **HIGH.** This is the only phase that edits the live dispatch path.
- **Rollback** — `PARK_DISPATCH_ENABLED=false` restores the exact current behaviour with no deploy; an
  empty `park` table is a second independent kill switch.
- **Depends on** — Phases 1–3.
- **Acceptance** — with the flag off, direct-dispatch metrics are statistically unchanged over 48 h;
  with it on and a test park, all concurrency tests pass; no ride is ever assigned twice.

---

### Phase 5 — Dispatcher application MVP

- **Objective** — a dispatcher can log in, open a shift, see requests, claim, and assign by badge.
- **Files** — new `apps/keke_dispatcher` Flutter app; `routes/dispatcher_routes.ts` (shift, check-in,
  queue, markers).
- **Migrations** — none.
- **APIs** — shift open/close; driver check-in/out; queue read; badge scan/lookup; markers.
- **UI** — shift start (with on-site location check) · request inbox · assign (scan / code / roster) ·
  photo-confirm · result · queue · roster · incident · handover.
- **Tests** — widget tests for the confirm screen; integration tests against a staging backend; offline
  behaviour (assign disabled, never a false success); device-binding rejection.
- **Risk** — **low** to the backend; the app is new.
- **Rollback** — do not distribute the build; revoke devices.
- **Depends on** — Phase 4.
- **Acceptance** — two dispatchers complete a full shift on a staging park; every action appears in
  `ParkAuditEvent` with the right `staffId`, `deviceId` and `shiftId`.

---

### Phase 6 — Smartphone-driver handoff

- **Objective** — a park-assigned app driver confirms and takes over the normal lifecycle.
- **Files** — `socket_handler.ts` (`ride:park_assignment`, confirm handler); `keke_driver`
  (`driver_controller.dart`, new confirm sheet).
- **Migrations** — none.
- **APIs/events** — `ride:park_assignment` (driver room + FCM), `ride:park_assignment_confirm`,
  `ride:park_assignment_lapsed`.
- **UI** — driver: park-assignment confirm sheet with pickup details and a countdown.
- **Tests** — confirm within the window; lapse; driver already on a ride; suspended mid-window;
  dispatcher reassignment after a lapse; **the driver's normal GPS gates still apply afterwards**.
- **Risk** — **medium** — a driver-app change, but purely additive; old builds simply never receive
  a park assignment (they are filtered out by `driverDeviceMode`).
- **Rollback** — stop assigning to `driverDeviceMode = 'app'` drivers; server-side config.
- **Depends on** — Phases 4, 5.
- **Acceptance** — an app driver assigned from a park completes a ride whose lifecycle events and
  integrity checks are indistinguishable from a direct ride.

---

### Phase 7 — No-smartphone passenger-led lifecycle

- **Objective** — a `park_managed` ride runs end to end on passenger confirmations, with graded
  confidence and **settlement still disabled**.
- **Files** — `services/passenger_lifecycle_service.ts`, `ride_integrity_service.ts` (add
  `evaluatePassengerCompletion` **alongside** the existing evaluator), `socket_handler.ts` (passenger
  confirm handlers), `keke_passenger` (`booking_controller.dart`, `booking_state.dart`,
  `booking_sheet.dart`, new confirm cards, location sampling).
- **Migrations** — `RideConfirmationEvent`; confidence + passenger-fix columns on `Ride`.
- **APIs/events** — `ride:passenger_confirm_arrival`, `ride:passenger_confirm_start`,
  `ride:passenger_confirm_completion`, `ride:park_state`; `ride:fallback_code_required`.
- **UI** — passenger: "Is your Keke here?", "Have you reached your destination?", the no-live-tracking
  card, and the privacy disclosure for location sampling.
- **Tests** — every confidence level produced by the right evidence; no confirmation → auto-complete
  held at 30 min; network loss mid-ride; app closed and reopened; disputed completion; **a dispatcher
  cannot reach any lifecycle endpoint** (explicit negative test).
- **Risk** — **medium-high.** New completion path. Mitigated by shipping with settlement off:
  evidence is logged and money is held for every park ride until the data says the grading is right.
- **Rollback** — `park_settlement_enabled = false` (already off in this phase); refuse new
  `park_managed` assignments.
- **Depends on** — Phases 4, 5. **Requires privacy sign-off for location sampling (§2.7).**
- **Acceptance** — 20 staged rides produce the expected confidence grade every time; no ride settles;
  the held-for-review queue shows complete, readable evidence.

---

### Phase 8 — Wallet top-up, cashier and reconciliation

- **Objective** — a park driver can clear debt with cash, and finance can reconcile it.
- **Files** — `models/CashCollection.ts`, `CashVariance.ts`; `services/cash_collection_service.ts`;
  `routes/cashier_routes.ts`; `wallet_service.ts` (enforce `DEBT_HARD_BLOCK`); `keke_dispatcher`
  (cashier mode); `keke_admin` (reconciliation).
- **Migrations** — two tables.
- **APIs** — record collection; shift declaration; supervisor count; finance reconcile; reversal.
- **UI** — cashier: collect, receipt, shift declaration. Admin: reconciliation queue, float ageing,
  variance report.
- **Tests** — ledger correctness on every path (collection, reversal, mistaken credit, spent credit
  producing debt); float cap; supervisor approval; **a property test asserting `WalletService` is the
  only writer to `Wallet`**; concurrent collection + ride settlement.
- **Risk** — **HIGH — money.** Requires written financial-controls sign-off before a line is written.
- **Rollback** — disable the cashier routes; collections already posted stand (they are real money) and
  are reconciled manually.
- **Depends on** — Phases 1, 5. **Requires §10 sign-off.**
- **Acceptance** — a full simulated shift reconciles to ₦0 variance; a reversal produces correct
  compensating entries; a driver over `DEBT_HARD_BLOCK` cannot be assigned.

---

### Phase 9 — Monitoring, fairness and fraud controls

- **Objective** — operations can see, measure and police the whole thing.
- **Files** — `services/park_metrics_service.ts`; `dispatch_monitor_query_service.ts` (park fields);
  `keke_admin` (park dashboards, bias reports, disputes); `models/RideDispute.ts`.
- **Migrations** — `RideDispute`.
- **APIs** — park metrics; bias report; override log; dispute CRUD.
- **UI** — admin: park performance, queue fairness, dispatcher overrides, disputes, live park requests
  with claim countdowns and force-release.
- **Tests** — metric correctness against fixtures; Gini calculation; permission gating.
- **Risk** — **low.** Read-mostly.
- **Rollback** — hide the sections.
- **Depends on** — Phases 4–8.
- **Acceptance** — every pilot success metric in §12.3 is visible on a dashboard before the pilot
  starts. *A metric that cannot be read cannot be a success criterion.*

---

### Phase 10 — One-park pilot

- **Objective** — run it for real, staged over four weeks (§12.1).
- **Files** — none. Configuration, training, SOPs, daily reconciliation.
- **Risk** — contained by park scope, the staged rollout and the abort triggers.
- **Rollback** — `Park.status = 'suspended'` stops one park; `PARK_DISPATCH_ENABLED=false` stops
  everything, with no deploy.
- **Depends on** — Phases 1–9.
- **Acceptance** — §12.3 in full.

---

## 13.1 Critical path

```
Phase 0.9 ─┐  (independent, can run in parallel with 1–3)
Phase 1 ──► 2 ──► 3 ──► 4 ──► 5 ──┬──► 6 ──┐
                                  └──► 7 ──┼──► 9 ──► 10
                        Phase 8 ──────────┘
```

Phases 6 and 7 are parallelisable after 5. Phase 8 depends only on 1 and 5, so financial work can start
as soon as its controls are signed off, without waiting for the no-smartphone lifecycle.

---

# 14. OPEN DECISIONS STILL REQUIRING PRODUCT APPROVAL

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | Is a **180 s** worst-case search acceptable (vs 110 s today)? | Yes, with pre-alert making p50 ≈ 150 s and honest interim copy | Phase 4 |
| 2 | **Passenger location sampling** during park rides — approve the collection, disclosure and 90-day retention? | Approve; it is the only honest basis for completion integrity | Phase 7 |
| 3 | **Dispatcher ≠ cashier** at the pilot? | **Separate them.** Dual-role only behind a flag with a ₦10,000 cap and daily reconciliation | Phase 8 |
| 4 | Cashier **float cap** and immediate-relief policy | ₦30,000 cap; relief immediate, reconciliation deferred | Phase 8 |
| 5 | Dispatcher **employment model** (staff, contractor, commissioned agent) | Employed or fixed-term contracted — commission-based pay creates an assignment-bias incentive | Phase 1 |
| 6 | **Dispatcher access to passenger contact** — permitted at all? | Only under a live incident, time-boxed to 30 min, audited | Phase 0.9 |
| 7 | **Wallet-paid park rides** in pilot 1? | **No.** Cash is the use case; one payment path is enough to validate | Phase 7 |
| 8 | Auto-complete window with **no passenger confirmation** | 30 minutes, then complete **held** | Phase 7 |
| 9 | **Badge issuance authority** and lost-badge fee | `operations` + `park_supervisor`; replacement fee is a commercial call | Phase 3 |
| 10 | **Device ownership and loss liability** | KekeRide-owned; loss policy in the dispatcher contract | Phase 3 |
| 11 | Does the passenger ever learn the ride came from a **park**? | **No.** The driver card is identical; only the tracking limitation is disclosed, and only when true | Phase 7 |
| 12 | **`DEBT_HARD_BLOCK`** — enforce at ₦5,000 or delete? | Enforce | Phase 8 |
| 13 | **Second park fallback** — pilot 2 or later? | Later. It would push the ceiling to 250 s | post-pilot |
| 14 | **Call relay** vs controlled reveal | Reveal in v1; relay after the pilot proves the volume justifies telephony spend | post-pilot |

---

# 15. RECOMMENDATION — WHAT TO BUILD FIRST

**Build Phase 1 (staff identity) first, and Phase 0.9 (contact privacy) in parallel.**

Neither is Park Dispatch. Both are the reason Park Dispatch can be built safely, and both are worth
shipping even if Park Dispatch were cancelled tomorrow.

**Why Phase 1 first.** Every park entity references a staff member — who claimed, who assigned, who
issued the badge, who took the cash. Building park tables against a shared environment API key means
`ParkAuditEvent.staffId` would hold a role label, and the audit trail — the single control the entire
fraud model depends on — would be worthless. Retrofitting identity later means migrating every audit
row that already exists. It also has independent value: right now nobody can tell which human approved
a driver or voided a ride.

**Why Phase 0.9 in parallel.** It is an active privacy defect: every rung driver receives the
passenger's phone number, whether or not they take the ride. It needs a three-release sequence with a
wait for app adoption in the middle (§7.2), so **the clock should start now** — otherwise it becomes
the thing that blocks Phase 4. It also fixes a real existing bug: a driver whose app restarts mid-ride
loses the call button.

**Then Phase 2** (additive DDL, zero risk) **and Phase 3** (admin surface, isolated), which together
let operations create a real park and print real badges — physical artefacts with a lead time that
should not sit on the critical path.

**Do not start Phase 4 until 1–3 are done and the §14 decisions 1, 5 and 6 are answered.** Phase 4 is
the only phase that edits the live dispatch path, and it should be the most boring change of the
project by the time it is written: one guarded branch inside `finalizeUnsuccessfulDispatch`, calling a
service that has already been built and tested against everything except a real ride.

---

## Summary of what changed in Phase 0.5

1. **The passenger keeps a two-tap journey.** No mandatory code, speech or scan — the `pickupCode`
   reverts to the passive display it already is, and becomes a fallback for exception paths only.
2. **Confidence is graded, not binary.** Five start/completion levels decide auto-settle vs flag vs
   hold, and no dispatcher action can produce any of them.
3. **Option B, capped at 180 s** — park pre-alert removes human reaction time from the critical path,
   and a round-transition event keeps the existing passenger app's 150 s watchdog from firing early.
4. **Staff identity is a separate system and comes first**, because every audit row in the design
   points at it.
5. **The contact privacy fix needs three releases**, not one, because a naive fix would silently
   remove the call button from every driver phone in the field.
6. **Claim atomicity introduces no new arbiter** — park assignment ends in the same conditional UPDATE
   that direct acceptance uses, so "two drivers for one passenger" remains impossible by construction.
