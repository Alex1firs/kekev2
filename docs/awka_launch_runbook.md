# Awka launch runbook

Turning on a second city. Everything below is a configuration change against a
system that is already deployed and already carrying Onitsha traffic — there is
no code release in the launch path, and no app release (see
[App release](#app-release)).

Two dials, deliberately separate:

| Dial | Values | What it means |
|---|---|---|
| `status` | `draft` → `active` | Whether the zone exists as far as **dispatch** is concerned. |
| `enforcement` | `off` → `observe` → `enforce` | Whether the geographic constraint **decides** anything. |

`draft + enforce` is rejected by `ServiceZoneService.setMode` — a zone cannot
enforce something it is not operating.

Effective within **60 s** (`SERVICE_ZONE_CACHE_TTL_MS`), across both blue-green
colours, with no restart.

---

## Before launch day

1. **Confirm the frozen model.** Onitsha `active/observe`, Awka `draft/off`,
   zero enforcing zones.

   ```sql
   SELECT code, status, enforcement, "bufferMeters", priority FROM service_zone ORDER BY code;
   SELECT count(*) FROM service_zone WHERE enforcement = 'enforce';   -- expect 0
   ```

2. **Confirm the kill switch is not already engaged.** `SERVICE_ZONES_ENABLED`
   must be unset or `true`. If it is `false`, every zone is inert regardless of
   these dials, and turning it back on needs a deploy.

3. **Take a backup.** `infra/` has the standard dump; keep it on the droplet at
   `/root`. The activation itself is one UPDATE, but the rollback is only as
   good as the backup behind it.

4. **Confirm the Operations console shows zones.** Open the queue: every ride
   should carry a city chip ("Onitsha"), and a pickup outside every service area
   should read "Outside service areas" in red. Open a ride you control: the
   driver list header should say *Drivers for Onitsha*, and each driver should
   carry Onitsha / Awka / Outside service areas / Location stale. If any of that
   is missing, the console is serving a cached build — see
   `project_admin_nginx_serving`; a hard reload settles it.

5. **Onboard the Awka drivers.** Their `driver_profile.homeZoneCode` should be
   `AWK`, but this is bookkeeping, not permission — eligibility is decided by
   live position, not by home zone. A driver with `homeZoneCode = 'ONI'`
   standing in Awka is Awka-eligible on his first fresh fix.

---

## Activation

One statement. Nothing else.

```sql
UPDATE service_zone SET status = 'active', "updatedAt" = now() WHERE code = 'AWK';
```

Leave `enforcement` at `off` (or move it to `observe`). **Do not enforce on day
one** — see [Enforcement is a separate decision](#enforcement-is-a-separate-decision).

Verify, within 60 s:

```sql
SELECT code, status, enforcement FROM service_zone ORDER BY code;
```

Then confirm the runtime actually sees it — request a ride from an Awka pickup
and check the row:

```sql
SELECT "rideId", "zoneCode", "zoneMatchKind", "createdAt"
FROM ride ORDER BY "createdAt" DESC LIMIT 5;
```

`zoneCode = 'AWK'` on that row is the proof. Until you see it, Awka is not live
no matter what the config table says.

---

## After activation

Watch three things for the first hour:

1. **Onitsha volume.** `SELECT count(*) FROM ride WHERE "createdAt" > now() - interval '1 hour';`
   compared with the same hour yesterday. Awka activation must not move it.

2. **Awka rides classifying correctly.** Every Awka pickup should carry
   `zoneCode = 'AWK'`. A run of `NULL` means pickups are landing outside the
   drawn boundary — a map problem, not a dispatch problem.

3. **Misses near Awka.** `SELECT "nearestZoneCode", count(*), min("distanceMeters"), max("distanceMeters")
   FROM service_area_miss WHERE "createdAt" > now() - interval '1 day' GROUP BY 1;`
   Rows with `nearestZoneCode = 'AWK'` and a small distance are the boundary
   being drawn slightly too tight. That is a polygon edit, not an incident.

---

## Rollback

Also one statement, and it does not touch Onitsha:

```sql
UPDATE service_zone SET status = 'draft', enforcement = 'off', "updatedAt" = now() WHERE code = 'AWK';
```

Within 60 s, Awka pickups resolve `outside` again and no Awka ride reaches
dispatch. Onitsha is byte-identical either side — proven in
`awka_certification_db.test.ts` → *ROLLBACK — AWK can be taken dark again
WITHOUT disturbing ONI*.

Rides already in flight are unaffected: a ride carries the `zoneCode` it was
born with, for its whole life.

**Emergency, both cities:** set `SERVICE_ZONES_ENABLED=false` and deploy. Every
path then behaves exactly as it did before service zones existed. This needs a
deploy on purpose — it must not be flippable at 2 a.m. and forgotten.

---

## Enforcement is a separate decision

Activating Awka and enforcing geography are two changes, and they should not be
made on the same day.

While `enforcement` is `observe`, a request from outside every zone is logged
and recorded in `service_area_miss` and then **dispatched exactly as before**.
Nothing is refused. That is what production has been doing for Onitsha since 2
September, and 13 misses have accumulated with `refused = false`.

Moving to `enforce` changes one thing: a pickup outside every active zone gets
`ride:error` / `OUTSIDE_SERVICE_AREA` and is not dispatched. Before making that
change, read [App release](#app-release) — the passenger app does not yet
recognise that code.

```sql
-- only after the app release, and only with the miss data in front of you
UPDATE service_zone SET enforcement = 'enforce', "updatedAt" = now() WHERE code IN ('ONI','AWK');
```

Note the fail-closed rule: with **two or more** zones enforcing, a resolver
fault refuses the request rather than dispatching unconstrained
(`ServiceZoneService.shouldFailClosed`). With one enforcing zone it does not.
Enforcing both cities at once therefore also switches on that behaviour.

---

## App release

**Awka launch needs no app release.** Verified:

- Passenger place search is `components=country:NG` — nationwide, no city bias
  (`map_repository.dart:112`).
- The passenger map's no-fix fallback is already Awka Main Park
  (`booking_controller.dart:495`), and the landmarks rail already lists eight
  Awka places (`booking_sheet.dart:1004`).
- Neither app decides geography. Zone resolution, candidate discovery and
  eligibility are all server-side.

**Enforcement needs the corrected passenger build to be widely installed.**
`OUTSIDE_SERVICE_AREA` now maps to its own outcome
(`RideOutcome.outsideServiceArea`, `booking_notice.dart`), shown as *"KekeRide
isn't in this area yet"* with **Change pickup** and deliberately no **Search
again** — retrying from the same pin can never succeed.

That fix only helps a handset that has it. An older binary still falls through
to `RideOutcome.serverFailed` and reads *"Something went wrong on our end —
please try again in a moment"*: a false statement plus a futile instruction.
So enforcement waits on **adoption**, not on the release existing. See
[App releases](#app-releases) in the hardening report.

Cosmetic, non-blocking: the driver app's initial camera is hardcoded to
`6.1264, 6.7876` (`driver_home_screen.dart:400`), 33 km west of Onitsha. It
snaps to the driver's real position as soon as the first fix arrives, so an
Awka driver sees the wrong place for a moment at launch.
