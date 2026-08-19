# Ride Operations

The investigation console. It answers one question for any ride ever
requested — *what actually happened?* — without anyone opening a database or
reading server logs.

Before this, Ride History showed ride id, status, payment and fare. `failed`
told an operator the outcome and nothing about the cause, and there was no way
to reach the detail view for a ride that had already finished.

---

## What was already there

Most of the machinery existed and was working. Worth stating plainly, because
the temptation on a brief like this is to build a second one:

- **`dispatch_event`** — an append-only, per-ride, sequence-ordered trail with
  46 event types and no personal data. Live since 26 July 2026.
- **`projectDispatchEvent`** — maps the orchestrator's log events onto those
  rows. Wired into `DispatchPorts.log` in the socket handler.
- **`DispatchMonitorQueryService.requestDetail`** — the full investigation
  payload: masked passenger, per-driver candidate outcomes, rollup, timeline.
  Always keyed by `rideId` alone, so it always worked for terminal rides.
  Nothing linked to it for one.
- **`revealContact`** — audited, permission-gated contact disclosure.
- **`maskPhone` / `maskName` / `maskEmail` / `areaOf`** — the privacy and
  locality helpers.

What was missing was the **reason on the ride row**, the **list** (filters,
search, paging, aggregates), and a **route into the detail view for history**.

## What was added

| | |
|---|---|
| `Ride.outcomeReason` | Stable code — `NO_ELIGIBLE_DRIVER`, `PASSENGER_CANCELLED`, … |
| `Ride.outcomeDetail` | Finer discriminator, e.g. `offers_delivered_none_accepted` |
| `Ride.cancelledByRole` | `passenger` / `driver` / `admin` / `system` |
| `services/ride_outcome.ts` | The code vocabulary, labels and classification |
| `services/ride_operations_service.ts` | List, summary and filter options |
| `services/ride_operations_switch.ts` | The telemetry kill switch |

Codes are the source of truth. English exists only in `OUTCOME_LABELS` and can
be reworded without a migration; nothing queries on it.

---

## The distinction the codes exist to preserve

`status` says what happened. `outcomeReason` says why. Three failures that all
render as `failed` are three different businesses to be in:

| Class | Code | What it means | What you do about it |
|---|---|---|---|
| `supply` | `NO_ELIGIBLE_DRIVER` | Demand existed, we had nobody | **Recruit drivers there** |
| `behaviour` | `NO_DRIVER_ACCEPTED` | Drivers were there and did not take it | Driver engagement |
| `technical` | `TECHNICAL_FAILURE` | We broke | Fix us |
| `intentional` | `*_CANCELLED` | Somebody chose to end it | Not a failure |

A restart that kills searching rides is `TECHNICAL_FAILURE`, deliberately, so
those rides never appear as evidence that Onitsha needs more Kekes.

---

## Legacy rides

**The backfill projects recorded evidence. It never guesses.**

Three sources, applied strictest-first: `status = 'completed'`,
`cancellationReason`, and the `dispatch_failed` event's `outcomeCode`.

Anything with none of those keeps `outcomeReason = NULL` and renders
**"Reason unavailable — legacy ride"**. At the time of writing that is **444 of
824** production rides — 256 failed and 188 cancelled — which ended before the
dispatch trail existed on 26 July 2026.

The console shows that count as an **Unexplained** card rather than hiding it.
It is the honest measure of how far back the trail reaches, and it should
visibly shrink as a proportion over time. Filling those rows in with a
plausible-looking cause would poison exactly the supply reports this console
exists to produce.

---

## The kill switch

Telemetry is written from inside the live dispatch path, so it can be turned
off without a deploy. Two layers, mirroring `ParkDispatchSwitch`:

```bash
# 1. Shipped posture. Needs a container restart (~10s of 502 on this stack).
RIDE_OPERATIONS_TELEMETRY_ENABLED=true    # default when unset
```

```bash
# 2. Redis override — takes effect within 5s, no restart, no deploy.
curl -X POST https://api.kekeride.ng/api/v1/admin/rides/operations/telemetry \
     -H "Authorization: Bearer $STAFF_TOKEN" \
     -d '{"enabled": false, "reason": "db under pressure"}'
```

**The override can only disable.** It cannot switch telemetry on when the
environment says off, so a monitoring credential can never enable writes the
deployment did not sanction. Requires `admin:write`; reading state needs only
`monitor:read`. Both are audited.

### Why the check is cached

`ParkDispatchSwitch` can afford a Redis `GET` per dispatch decision. This one
cannot: telemetry fires many times per ride — one row per candidate discovered,
per eligibility rejection, per offer — and every one of those sits on the
dispatch path. An awaited round-trip per event would put network I/O between a
passenger and a driver.

So `isEnabled()` is **synchronous**, reading a boolean refreshed in the
background at most once per 5 seconds. Whoever notices the cache is stale kicks
off a refresh and proceeds with the value it already had. If Redis is
unreachable the switch reports "not disabled" — Redis being down is not a
reason to lose observability.

### What "off" means

New dispatch telemetry rows stop being written. **Dispatch behaviour does not
change** — no timing, no ordering, no eligibility, no outcome. Rides dispatched
while it is off have a thinner trail, and the console says so: the banner shows
**Telemetry OFF**, because a short timeline has two very different causes and an
operator must be able to tell "nothing happened" from "we were not recording".

`outcomeReason` on the ride row is **not** governed by this switch. It is part
of the ride record, not telemetry, and is written in the same `UPDATE` as the
status it explains. A `failed` row with no reason is the defect this work
removes, and it must not be able to return because someone silenced the trail.

---

## Safety properties

Everything below is enforced by a test in
`test/unit/ride_operations.test.ts`.

- `record()` is fire-and-forget and returns `undefined`, so no caller can
  accidentally await it and inherit its latency.
- A rejection inside `recordAsync` is caught. **This was a real bug**: the
  method did `void this.recordAsync(args)` with the Redis freshness lookup
  outside the `try`, so a synchronous throw from a closed client became an
  unhandled promise rejection inside the offer loop — process-fatal under
  current Node defaults. Found by the failure-injection test, not by review.
- A throwing admin-socket emitter cannot break the write path.
- The projection is pure: it does not mutate the log fields it is handed, so it
  cannot edit dispatch state from inside an observer.
- A cancelled ride is never recorded as a dispatch failure — otherwise every
  passenger who changed their mind appears in the "we had no Kekes" report.

---

## API

All under `/admin`, all behind `adminAuth` + `requireStaffAuth`, all
`monitor:read` except where noted.

| Endpoint | Purpose |
|---|---|
| `GET /rides/operations` | Paged, filtered, searched list |
| `GET /rides/operations/summary` | Cards — honours the same filters |
| `GET /rides/operations/filters` | Dropdown values, drawn from real data |
| `GET /rides/operations/:rideId` | Investigation payload (audited) |
| `GET /rides/operations/telemetry` | Switch state |
| `POST /rides/operations/telemetry` | Toggle — **`admin:write`**, audited |
| `POST /live-requests/:rideId/reveal-contact` | Unmasked contact — **`monitor:reveal_contact`**, audited |

Filters: `from`, `to`, `status`, `outcomeReason`, `cancelledByRole`,
`pickupArea`, `destinationArea`, `passengerId`, `driverId`, `q`, `page`,
`pageSize` (clamped to 100).

### Search

`q` matches ride id, and passenger/driver first name, last name, full name,
email, phone and vehicle plate. Phone comparison strips non-digits on both
sides, so `0803 123 4567`, `+2348031234567` and `8031234567` all find the same
person — support staff type a number however the caller reads it out.

Identities are resolved against `user` and `driver_profile` **first**, then the
ride table is queried by the indexed `passengerId` / `driverId`. Joining `user`
into the ride query and running `ILIKE` across it cannot use an index on either
side and degrades with every ride ever taken; this degrades only with the number
of people, which grows far more slowly.

---

## The timeline

Merged from two authoritative sources, because neither is complete alone:

- **`dispatch_event`** covers request → assignment.
- **The ride row** carries arrival, trip start and completion, which are
  recorded by `RideIntegrityService` with GPS evidence and are not in the
  dispatch trail at all.

Nothing is synthesised. Every entry corresponds to a row or a non-null timestamp
that something actually wrote; a ride missing `arrivedAt` simply has no arrival
entry. Each entry is tagged `dispatch_event` or `ride_record` so an operator
questioning one knows which source it came from.

A cancelled ride's `completedAt` is **never** rendered as a completion —
`completedAt` means "terminal at", not "finished successfully", and showing it
as a completed trip would tell a support agent the passenger got their ride when
they did not.

---

## Privacy

- Contact details are masked by default, exactly as the live monitor masks them.
- Revealing them requires `monitor:reveal_contact` and writes an audit row with
  the reason the agent typed.
- Opening a ride writes a `VIEW_RIDE_INVESTIGATION` audit row.
- `dispatch_event.detail` holds reason codes, counts and opaque ids — never
  names, phones or emails. Identity is joined from `User` / `DriverProfile` at
  render time.
- Addresses come from what the passenger app captured at request time. **No
  geocoding call is made to open a ride**, however many an operator opens.

---

## Demand intelligence

The persisted shape supports these without further schema work:

- Requests by pickup area and hour — `pickupAddress` + `createdAt`
- Failure rate by area — `outcomeReason` + `pickupAddress`
- Supply gaps vs acceptance gaps — `classifyOutcome` splits `supply` from
  `behaviour`
- Completion rate — already on the summary card
- Which areas to recruit around — `NO_ELIGIBLE_DRIVER` grouped by pickup area

The analytics product is not built. The evidence to build it is no longer being
thrown away.

---

## Data quality: what the addresses actually look like

Worth knowing before reading the area column, because it shapes what the
console can honestly tell you.

Pickup addresses are whatever Google returned to the passenger's handset at
request time. Across 824 production rides:

| Shape | Count | Example |
|---|---|---|
| Multi-part address | 513 | `109, Upper New Market Road` |
| Begins with a plus code | 211 | `4QGP+JPF, Nweweka Street` |
| Single token | 100 | `Awka` |

A minority are a **bare** plus code (`4QHQ+3WF`) or the app's placeholder
(`Location selected`). Those carry no locality, so the console shows **"Area
not recorded"**. Guessing a neighbourhood from coordinates would mean a
reverse-geocode on every admin page load — a paid call per row — and would
still be a guess.

**If richer area data matters**, the fix belongs in the passenger app: capture
a locality/sublocality field alongside the formatted address at request time,
when the geocode result is already in hand and free. That is a passenger-app
change and is deliberately not in this work.
