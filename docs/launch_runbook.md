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

**Changing the switch needs a real staff login, not the shared admin key.**
`PARK_SUSPEND` is on `LEGACY_FORBIDDEN_PERMISSIONS` — a shared secret has no
human behind it, and the whole point of this action is being attributable. Use a
SUPER_ADMIN or OPERATIONS_ADMIN account. **Make sure at least one such account
has a working password before launch day**; discovering this at 09:00 is the
wrong time.

```bash
API=https://api.kekeride.ng/api/v1

TOKEN=$(curl -sX POST $API/staff/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ops@…","password":"…"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

# Off
curl -sX POST $API/admin/park-dispatch/switch \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":true,"reason":"dispatchers cannot reach the tablet"}'

# Back on
curl -sX POST $API/admin/park-dispatch/switch \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":false}'
```

Reading the state is less restricted — the shared key is fine:

```bash
curl -s $API/admin/park-dispatch/switch -H "x-admin-key: $ADMIN_API_KEY"
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

### 3d. Before dispatchers arrive

- [ ] At least one park is `active`, with `lat`/`lng` set and a service radius
      that actually covers the pickups you expect.
- [ ] Drivers are on that park's roster.
- [ ] Drivers who will take rides have **live badges** — no badge, not
      assignable.
- [ ] Dispatcher staff accounts exist with `PARK_DISPATCHER` and are scoped to
      the park.
- [ ] `STAFF_JWT_SECRET` is set (otherwise it is HMAC-derived from `JWT_SECRET`,
      which works but is worth doing properly).
- [ ] An operations account with `PARK_SUSPEND` exists and its password works —
      the kill switch cannot be used without one.
- [ ] Run the verification script; it must exit 0:

      API=https://api.kekeride.ng/api/v1 ADMIN_KEY=… \
        OPS_EMAIL=… OPS_PASSWORD=… \
        DISPATCHER_EMAIL=… DISPATCHER_PASSWORD=… \
        ./scripts/verify_park_dispatch.sh

      It checks the switch, park readiness, the privilege boundaries and that
      passenger numbers are masked, and it drills the kill switch off and back
      on — leaving it on, and failing loudly if it cannot.
- [ ] Run the acceptance scenarios; they must exit 0:

      npx ts-node scripts/acceptance_park_dispatch.ts

- [ ] Open the app **on the actual tablet**, sign in, install it to the home
      screen, and open a shift. §6 below is the part no script can do.

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


---

## 6. The device test, which no script replaces

Everything above is software checking software. It cannot tell you whether a
dispatcher can actually work a shift with it. Before Monday, someone has to
stand in the park and do this.

**What you need:** one passenger phone, the dispatcher's Android tablet, one
smartphone driver, one feature-phone driver from the roster, and an operations
laptop.

| | Check | What "good" looks like |
|---|---|---|
| 1 | Install the PWA from `dispatch.kekeride.ng` | Offers "Add to Home Screen"; the icon is the KekeRide diamond; opening it has no browser address bar |
| 2 | Sign in with the phone number on the staff card | Works, not just the email address |
| 3 | Sound test during shift setup | Audible across the park **at the tablet's normal volume**, with the park at its normal noise |
| 4 | Book a ride that direct dispatch cannot fill | Appears on the board within a few seconds, chimes, vibrates |
| 5 | Walk away from the tablet for a minute | The reminder chimes again; the banner is still up when you get back |
| 6 | Assign the smartphone driver | Their phone shows the offer; accepting clears the board |
| 7 | Assign the feature-phone driver verbally | Ask them out loud first, then assign; the ride is theirs immediately |
| 8 | Have the smartphone driver decline | The request comes back within seconds, and they drop down the list |
| 9 | Turn the tablet's data off mid-shift | Within ~20s the board says it is stale and not to assign from it |
| 10 | Turn data back on | It catches up without a manual refresh |
| 11 | Double-tap Assign hard | One assignment, one Keke |
| 12 | Try to end the shift with a request in hand | Refused until it is released or handed over |
| 13 | Suspend Park Dispatch from the operations laptop | The dispatcher sees the red banner; the request they already hold is still assignable |
| 14 | Let the assigned ride run to completion | Ordinary lifecycle: arrive, start, complete, payment. Nothing park-specific |
| 15 | One-handed use | The dispatcher can take a request and assign a driver while holding a phone in the other hand |

Record what actually happened, including anything that only half-worked. A
dispatcher who cannot hear the chime over the park is a launch blocker even
though every test in this repository passes.

---

## 7. Merging

```bash
# Confirm the engine is untouched — expect no output.
git diff f0e36fa..HEAD --stat -- \
  apps/keke_backend/src/services/dispatch_orchestrator.ts \
  apps/keke_backend/src/services/dispatch_service.ts \
  apps/keke_backend/src/services/driver_eligibility_service.ts \
  apps/keke_backend/src/config/dispatch_config.ts \
  apps/keke_backend/src/services/wallet_service.ts

# Confirm no secrets — expect no output.
git diff f0e36fa..HEAD | grep -nE '(SECRET|PASSWORD|API_KEY|PRIVATE_KEY)\s*[:=]\s*["'"'"'][^"'"'"'$]' \
  | grep -v 'process.env' | grep -v 'KekeDemo-Pass99'

# Tag the current production commit so there is something to go back to.
git tag pre-park-dispatch f0e36fa && git push origin pre-park-dispatch

git checkout main && git merge --no-ff <branch> && git push origin main
```

`--no-ff` deliberately: this is a feature with a shape, and a merge commit keeps
it revertable as one thing.

---

## 8. Rolling back

In order of cost. Try them in this order.

```bash
# 1. Suspend (seconds, no deploy). Rides already assigned are untouched.
#    See §2a — needs a staff login, not the admin key.

# 2. Environment off (one restart, ~10s of 502s).
PARK_DISPATCH_ENABLED=false
docker compose up -d api_prod

# 3. Roll the code back (a deploy).
git revert -m 1 <merge-commit> && git push origin main
# then on the droplet: build, up -d. Do NOT revert the migrations.
```

**Leave the migrations in place.** They are additive, the old code ignores the
new columns, and reverting them would drop the park tables while jobs may still
reference them. Live park jobs at the moment of rollback become orphaned rows;
their rides are released by ordinary stale-ride recovery.

The one thing that is not cleanly reversible is
`1714500000001-NormaliseLegacyEnumNames`, which renames the ledger enum types to
the names the code already used. Its `down` is intentionally empty: reversing it
would rename production's types to a form nothing reads. It is a no-op on
production in the first place — see §3a.
