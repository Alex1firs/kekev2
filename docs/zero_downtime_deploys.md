# Zero-downtime deployment

How KekeRide releases backend code without dropping a ride request.

Measured before this work: **~40 seconds of 502s** on every deploy, because
`docker compose up -d api_prod` stops the only API container and starts a new
one.

Measured after: **zero failed requests**, across five deploys and rollbacks,
polling four public surfaces continuously from outside the droplet. A held
WebSocket survived the cutover and the entire drain, reconnecting in **1.5
seconds** only when the old colour was finally stopped.

---

## Why blue-green, and not replicas

The obvious answer is two permanent replicas behind nginx. It is the wrong one
here, and the reason is worth writing down.

`SocketHandler` keeps live dispatch state in **process memory** — seven maps:
`dispatchRuns`, `dispatchTimers`, `activeDispatches`, `dispatchPayloads`,
`rideExclusions`, `driverRideMap`, `earlyEndTimers`. With two replicas
permanently sharing traffic, a dispatch run started on replica A has its timers
and its exclusion set on A, while a driver's `ride:accept` may arrive at B.

Making that correct means moving dispatch state into Redis — a rewrite of the
engine that runs every ride on the platform. Not worth it, and explicitly out of
scope.

**Blue-green sidesteps it entirely: only one colour ever receives new traffic**,
so dispatch state is never split between two processes competing for the same
ride. The second colour exists only during a deployment.

### What makes the overlap safe

For a window during each deploy, both colours run at once. Three things make
that safe, and all three were already true:

1. **Acceptance is arbitrated by the database, not by memory.** `acceptRide`
   claims a ride with a conditional `UPDATE ... WHERE status = 'searching'`, and
   Postgres guarantees exactly one driver gets `affected = 1`. A driver whose
   socket is on the old colour accepting a ride dispatched from the new one is
   still arbitrated correctly.

2. **Both sweepers already take Postgres advisory locks.** `StaleRideSweeper`
   and `ParkJobSweeper` each contend for a fixed lock id and return immediately
   if another instance holds it. They were written for this.

3. **Every socket emit targets a room**, never a socket id — `ride:{id}`,
   `driver:{id}`, `park:{id}`, `admin`. Rooms are what the Redis adapter can
   route across processes. Socket-id targeting could not have been.

The one thing that was **not** already true: a room emit on the new colour could
not reach a socket connected to the old one. That is what the Redis adapter
below fixes, and it is the only change to the socket layer.

---

## The pieces

### 1. Socket.IO Redis adapter

`@socket.io/redis-adapter` publishes room broadcasts over Redis pub/sub so
`io.to('driver:X').emit(...)` reaches that driver whichever colour holds their
connection.

- **No call site changed.** The adapter is installed on the `Server` instance;
  every `io.to(...)` in `socket_handler.ts` is untouched.
- **Kill switch.** `SOCKET_REDIS_ADAPTER=false` disables it and restores exactly
  the previous single-process behaviour. If it ever misbehaves, that plus a
  restart is the fix.
- **Fails soft.** If the adapter cannot be created the server logs and continues
  with the default in-memory adapter. A broadcasting optimisation must never
  stop the process that carries ride requests from starting.

In steady state one colour is running and the adapter is doing nothing useful.
It matters only during the overlap.

### 2. Migrations moved out of container start

The image previously ran `npm run migration:run && node dist/index.js`. With two
colours that is a race: both would try to migrate.

Migrations are now an explicit deploy step, run once, **before** the new colour
starts. The app logs pending migrations loudly at boot but does not refuse to
start — refusing would turn a bookkeeping problem into an outage.

**Every migration must be backward-compatible**, because the old colour keeps
serving against the new schema for the whole drain window. In practice:

| Allowed during a rolling deploy | Not allowed |
|---|---|
| `CREATE TABLE` | `DROP TABLE` |
| `ADD COLUMN` nullable, or with a default | `DROP COLUMN` |
| `CREATE INDEX` (prefer `CONCURRENTLY`) | `ALTER COLUMN ... TYPE` |
| Adding an enum value | Renaming anything |
| Backfilling data | `SET NOT NULL` on a new column |

Removing a column is a **two-deploy** operation: deploy code that stops reading
it, then in a later release drop it. `infra/check_migration_compat.sh` greps
pending migrations for the destructive forms and refuses the deploy unless
`ALLOW_DESTRUCTIVE_MIGRATION=1` is set deliberately.

### 3. nginx points at a colour, resolved at request time

```nginx
set $prod_app http://api_prod_blue:4000;
proxy_pass $prod_app;
```

Assigning the upstream to a variable first forces nginx to resolve the container
name **per request** through Docker's DNS, instead of caching an IP at startup.
That is why an `upstream` block is deliberately not used: a container that
restarts gets a new IP, and an `upstream` would keep proxying to the old one
until somebody noticed.

The live colour is rendered from `infra/nginx/nginx.conf.template` — git holds
the template with `__PROD_COLOUR__`, the droplet holds the rendered artifact.
Cutover rewrites the file in place and runs `nginx -s reload`.

`nginx -s reload` is graceful: existing connections are served to completion by
the old workers while new ones use the new configuration. Nothing is refused.

### 4. Health-gated cutover

The new colour is never put in front of traffic on hope. The deploy script polls
its `/health` **directly, container to container**, and additionally smoke-tests
a real read path. Only then does nginx move.

---

## The deployment flow

```
infra/deploy.sh
```

1. **Determine the live colour** from the rendered nginx config.
2. **Build** the image. Tag the currently-running image as `:previous` first, so
   rollback has something to return to.
3. **Check migration compatibility** — refuses destructive DDL unless overridden.
4. **Run migrations** once, as a one-shot container.
5. **Start the idle colour.**
6. **Wait for health**, directly against the new container. Fails the deploy if
   it never becomes healthy — traffic has not moved, so this costs nothing.
7. **Smoke test** the new colour directly: `/health`, and an authenticated-free
   read that exercises Postgres and Redis.
8. **Cut over**: render nginx config for the new colour, `nginx -t`, reload.
9. **Verify through the public URL.** If this fails, cut straight back — the old
   colour is still running and still warm.
10. **Drain.** The old colour keeps running for `DRAIN_SECONDS` (default **180**)
    so in-flight dispatch runs — which live about 110 seconds — finish on the
    process that owns their timers. Sockets stay connected throughout; the Redis
    adapter carries emits across.
11. **Stop the old colour.** Its remaining sockets disconnect and clients
    reconnect to the new one.

Expected interruption: **none**. The cutover is an nginx reload, not a restart.

---

## Rollback

```
infra/rollback.sh
```

**Within the drain window** (the first 3 minutes): the previous colour is still
running and warm. Rollback re-renders nginx at the old colour and reloads —
**under a second**, no container start, no migration.

**After the drain**: the script starts the previous colour from the `:previous`
image tag, waits for health, then flips. Roughly the time of a container start.

**Database rollback is separate and deliberate.** Because migrations are
backward-compatible by policy, code rollback needs no schema rollback — the old
code runs fine against the new schema. That is the entire point of the
compatibility rule. If a migration must be reverted, do it as its own step:

```bash
docker compose run --rm --no-deps api_prod_blue npm run migration:revert
```

---

## What is still interrupted, honestly

- **WebSocket connections on the old colour end when it stops** — after the full
  drain. Socket.IO clients reconnect automatically and re-emit `register`, which
  re-joins their rooms. The gap is the client's reconnect delay, typically
  under a second, and dispatch offers are retried across two rounds over ~110
  seconds, so a sub-second gap does not lose a ride.
- **In-flight dispatch runs that outlive the drain** are lost when the old
  colour stops, exactly as they are today. Raising `DRAIN_SECONDS` above the
  ~110s run lifetime makes this rare rather than routine.
- **The first request to a cold colour** is slower — JIT, connection pools. It
  is served, just not as fast.
- **This does not survive a droplet reboot.** Both colours are on one host.
  Surviving host loss is a different problem (a second droplet, a load balancer)
  and is not solved here.

---

## Verification

Run from a machine **outside** the droplet — on the droplet you would skip
nginx, TLS and the network, which are the three places a cutover can actually
drop a request.

```bash
infra/measure_downtime.sh 300 &     # poll four surfaces continuously
infra/deploy.sh                     # on the droplet
```

### Measured on production, 2026-08-07

| Scenario | HTTP failures | Wall time |
|---|---|---|
| Transition from single-container to blue-green | 0 | — |
| Full deploy, blue → green, 180s drain | **0** / 636 polls | ~4 min |
| Full deploy, blue → green, 150s drain | **0** / 604 polls | ~3.5 min |
| Full deploy, green → blue, 120s drain | **0** / 436 polls | ~3 min |
| Rollback, previous colour **stopped** | **0** / 184 polls | 17 s |
| Rollback, previous colour **warm** ×2 | **0** / 224 polls | 4 s each |

Every run polled `/health`, `/dispatch/`, a passenger API path and the admin
dashboard. Not one returned 5xx or failed to connect.

### WebSocket behaviour, measured

An authenticated Socket.IO client held open through a full deploy:

```
+0.2s    CONNECT
+15s…+180s   alive=true      ← cutover happened in here; no disconnect
+194.2s  DISCONNECT  transport close   ← old colour stopped at end of drain
+195.7s  CONNECT                        ← reconnected, 1.5s gap
+210s…+255s  alive=true
```

The connection rode through the cutover untouched, survived the whole drain on
the old colour, and reconnected 1.5 seconds after that colour was stopped. A
dispatch offer is retried across two rounds over roughly 110 seconds, so a
1.5-second gap does not lose a ride.

### Cross-process broadcasts, verified

With both colours running, `PUBSUB NUMSUB socket.io-prod-request#/#` reports
**2** subscribers — both colours on one fabric — while
`socket.io-staging-request#/#` reports 1. Staging is deliberately on its own
namespace; see the note in `sockets/redis_adapter.ts`.
