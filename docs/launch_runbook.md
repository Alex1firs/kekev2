# Park Dispatch — Launch Runbook

Turning Park Dispatch on, turning it off, and diagnosing it at 09:00 on a Monday
when a park is not working and someone is on the phone.

Audience: whoever is on call. Assumes the existing production setup — dockerised
backend behind nginx on the droplet, Postgres and Redis alongside.

---

## 1. What ships enabled

`PARK_DISPATCH_ENABLED` **defaults to `true`**. Deploying this code turns Park
Dispatch on.

Everything else keeps its default; the tuned values are in
`src/config/park_dispatch_config.ts` and every one is overridable by
environment variable without a code change.

| Variable | Default | What it controls |
|---|---|---|
| `PARK_DISPATCH_ENABLED` | `true` | Master switch. `false` restores exactly the pre-Park behaviour. |
| `PARK_CLAIM_WINDOW_MS` | `25000` | How long a park has to claim an offered request. |
| `PARK_ASSIGN_WINDOW_MS` | `45000` | How long a claimed request has before a driver must be assigned. |
| `PARK_DRIVER_ACCEPT_WINDOW_MS` | `18000` | How long a smartphone driver has to answer. |
| `PARK_MAX_PARKS_PER_RIDE` | `1` | Parks a single ride may be offered to, in sequence. |
| `PARK_MAX_TRAVEL_MINUTES` | `12` | Parks estimated further than this are not offered the ride. |
| `PARK_REQUIRE_WAITING_DRIVER` | `true` | Skip parks with nobody assignable. |
| `PARK_EMIT_ROUND_EVENT` | `true` | Keeps already-installed passenger apps from timing out. Leave on. |

Booleans accept `true/1/yes/on` and `false/0/no/off`. An unrecognised value keeps
the default and logs a warning rather than guessing.

Total park phase at defaults is ~70s, inside the 180s ceiling fixed in
[`park_dispatch_mode_architecture.md`](park_dispatch_mode_architecture.md) §5.3
against the passenger app's 150s client-side watchdog. **If you lengthen
`PARK_CLAIM_WINDOW_MS` or `PARK_ASSIGN_WINDOW_MS`, re-check that arithmetic** —
going past it means passenger apps in the field give up while the server is
still working.

---

## 2. Turning it off

Two ways, for two situations.

### 2a. The one to use during an incident

Redis-backed override. Takes effect on the **next request**. No restart, no
deploy, no 502s.

```bash
# Off
curl -sX POST https://api.kekeride.ng/api/v1/admin/park-dispatch/switch \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"disabled":true,"reason":"dispatchers cannot reach the tablet"}'

# Back on
curl -sX POST https://api.kekeride.ng/api/v1/admin/park-dispatch/switch \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"disabled":false}'

# What is the current state?
curl -s https://api.kekeride.ng/api/v1/admin/park-dispatch/switch \
  -H "x-admin-key: $ADMIN_API_KEY"
```

A reason is **required** to disable and is written to the audit trail with
whoever presented the credential.

**What "off" means:** new rides stop entering the park phase. Work already in
flight is *not* abandoned — a job a dispatcher has claimed can still be
assigned, and a driver already offered a ride can still accept it. Killing live
jobs would strand passengers who are being served perfectly well at that moment.
In-flight work drains within one claim/assign window (~70s) and nothing arrives
behind it.

Dispatchers see a red banner explaining the pause, so a paused system does not
look like a quiet morning.

The override can only **disable**. It cannot enable Park Dispatch when the
environment says off — an operations credential must not be able to switch on a
dispatch path the deployment has not enabled.

There is **no TTL**. A kill switch that silently re-arms after an hour is a
trap; whoever turned it off decides when it comes back.

### 2b. The durable one

```bash
# on the droplet
PARK_DISPATCH_ENABLED=false   # in the compose env
docker compose up -d backend
```

Survives a Redis flush. Costs a container restart — about ten seconds of 502s on
this stack. Use it when the decision is "not this week", not "not right now".

If Redis is unreachable, the switch reports *not disabled*: Redis being down is
not a reason to take a working dispatch path offline, and 2b is still there as
the harder control.

---

## 3. Deploying

### 3a. Migrations

Four new migrations. **They must run in order**, and 1791 and 1792 are split
deliberately — Postgres refuses to *use* an enum value in the transaction that
created it, and this project runs `migrationsTransactionMode: 'each'`.

| | |
|---|---|
| `1791000000000-AddPendingAcceptance` | The `pending_acceptance` enum value, alone. |
| `1792000000000-PendingAcceptanceColumns` | Columns, indexes, and the rebuilt one-live-job-per-ride unique index. |
| `1793000000000-AddDriverOfferEvents` | Three dispatch-event enum values, alone, same reason. |

All additive. None rewrites an existing row. The `down` paths for the enum
migrations are intentionally empty — Postgres cannot drop an enum value without
recreating the type, and rows may reference them.

**Do not squash these into one migration.** It will pass in a test that runs
them with synchronize and fail on the droplet, which is exactly how the split
was discovered.

### 3b. Order

1. Migrations.
2. Backend.
3. The dispatcher app is served by the backend at `/dispatcher` — it ships with
   the backend, nothing separate to deploy.

No passenger or driver app release is required. Park offers reuse
`ride:request` / `ride:accept` / `ride:reject`, so installed driver apps handle
them with no change, and installed passenger apps are handled by the round
event.

### 3c. Before dispatchers arrive

- [ ] At least one park is `active`, with `lat`/`lng` set and a service radius
      that actually covers the pickups you expect.
- [ ] Drivers are on that park's roster.
- [ ] Drivers who will take rides have **live badges** — no badge, not
      assignable.
- [ ] Dispatcher staff accounts exist with `PARK_DISPATCHER` and are scoped to
      the park.
- [ ] `STAFF_JWT_SECRET` is set (otherwise it is HMAC-derived from `JWT_SECRET`,
      which works but is worth doing properly).
- [ ] `curl /api/v1/admin/park-dispatch/switch` reports `accepting: true`.
- [ ] Open `/dispatcher` on the actual tablet, sign in, open a shift.

---

## 4. Diagnosing

### "Nothing is reaching the park"

Work down this list; each step distinguishes two real causes.

```bash
# 1. Is the switch on? (env layer AND override, reported separately)
curl -s $API/admin/park-dispatch/switch -H "x-admin-key: $KEY"

# 2. Is anything even failing direct dispatch? Park only sees what direct missed.
curl -s $API/admin/park-dispatch/overview -H "x-admin-key: $KEY"

# 3. Per-park health: queue depth, who is on duty, waiting drivers
curl -s $API/admin/park-dispatch/health -H "x-admin-key: $KEY"

# 4. One specific ride's full park history
curl -s $API/admin/park-dispatch/rides/RIDE-xxxx -H "x-admin-key: $KEY"
```

If step 2 shows rides failing but no park jobs being created, the ride is being
*refused* by park selection. `PARK_DISPATCH_EXHAUSTED` events carry the reason
per park — out of radius, over `PARK_MAX_TRAVEL_MINUTES`, no assignable driver,
park not active, outside operating hours.

### "The dispatcher's board is frozen"

The connection pill is the answer. Red means the socket dropped and the
7-second poll is carrying the board — work continues, slower. If the pill is
green and the board is genuinely stale, that is a bug; capture the browser
console.

### "A ride is stuck"

It should not be possible, and the sweeper is why. It runs every 10 seconds
inside the backend process:

- expired driver offers → job back to the dispatcher's queue;
- expired claims and offers → job resolved, ride released.

```bash
docker compose logs backend | grep -i "park job sweeper"
```

The ride stays `searching` for the whole park phase, so if the park phase is
exhausted, existing stale-ride recovery owns it exactly as before.

### Useful Redis keys

| Key | |
|---|---|
| `park_dispatch:disabled` | Present ⇒ the override is engaged. Value is JSON: reason, who, when. |

---

## 5. What this deploy does not touch

Stated because the blast radius is the first question at 09:00:

`DispatchRun`, the dispatch orchestrator, radius tiers, the offer window, atomic
driver reservation, direct dispatch, driver eligibility, wallets, payments, fare
calculation, the ride lifecycle, and stale-ride recovery are **unmodified**.
Verifiable:

```bash
git diff <pre-park-commit>..HEAD --stat -- \
  apps/keke_backend/src/services/dispatch_orchestrator.ts \
  apps/keke_backend/src/services/dispatch_service.ts \
  apps/keke_backend/src/services/driver_eligibility_service.ts \
  apps/keke_backend/src/config/dispatch_config.ts
# expected: no output
```

`RideStatus` gains no values. Park state lives in its own `ParkDispatchJob`
machine while the ride stays `searching`, so every existing conditional UPDATE,
sweeper query and eligibility filter keeps working untouched.

A ride becomes `accepted` through the **same** conditional UPDATE a direct
acceptance uses — `WHERE rideId = ? AND status = 'searching'` — in the same
method. There is one arbiter, and Park Dispatch does not duplicate it. If a
direct driver accepts during the park phase, they win the UPDATE and the park
job is cancelled.

---

## 6. Rolling back

Park Dispatch off (§2a) restores the previous behaviour immediately without a
deploy: a ride direct dispatch cannot fill simply fails, as it did before.

A full code rollback is safe too — the migrations are additive and the old code
ignores the new columns. Live park jobs at the moment of rollback are orphaned
rows; their rides are released by ordinary stale-ride recovery. Prefer §2a
first: it is faster, reversible, and does not need a deploy window.
