# Field test: Awka launch day

The physical test that decides whether Awka goes public. Run it in Awka, on the
day, before you tell a single passenger the service is live.

Three phones: **one passenger, two drivers.** A third driver phone makes test 6
sharper but is not required. Budget about two hours including travel between
the two cities for test 7.

Nothing here is a simulation. Every PASS below is a real ride request from a
real handset standing in a real place.

---

## Before you start

**Activate Awka** — see [`awka_launch_runbook.md`](awka_launch_runbook.md).
`status = 'active'`, `enforcement` left at `off` or `observe`.

**Check the starting state:**

```sql
SELECT code, status, enforcement FROM service_zone ORDER BY code;
-- expect: AWK active | ONI active, and NO zone at 'enforce'
```

**Have open, on a laptop:** the Operations console, and a psql session on
`keke_prod_db`. Every test below is confirmed in the database, not by watching
the app. An app can show the right thing for the wrong reason.

**Both driver phones:** logged in, ONLINE, app backgrounded (screen off is
better — that is the state drivers actually work in).

---

## The tests

### 1 · Awka ride reaches an Awka driver

**Do:** Stand at Aroma Junction. Driver A parks within ~1 km. Passenger requests
a ride to Eke Awka Market.

**PASS:**
- Driver A's phone rings within 30 s, screen off.
- `SELECT "zoneCode","zoneMatchKind" FROM ride WHERE "rideId" = '…';` → `AWK | exact`
- Ride is accepted and the passenger sees Driver A.

**FAIL — stop the launch:** `zoneCode` is `NULL` or `ONI`; no driver is rung;
the ride is offered to somebody who is not in Awka.

### 2 · The full trip completes and the money is right

**Do:** Complete test 1's ride end to end — arrive, start, drive, complete. Pay
cash. Note the fare.

**PASS:**
- `status = 'completed'`, `finalFare` matches what both phones showed.
- Driver's commission debt increased by `fare − fare/1.1` (₦1,100 → ₦100).
- `zoneCode` is still `AWK` on the completed row.
- Driver's earnings screen and the passenger's receipt agree with the fare.

**FAIL:** any of the three numbers disagree; `zoneCode` changed during the trip.

### 3 · Onitsha is untouched

**Do:** Have someone in Onitsha request an ordinary ride at the same time, from
a normal Onitsha pickup, with an Onitsha driver online.

**PASS:** it behaves exactly as it did yesterday — same time to first offer,
same driver pool, `zoneCode = 'ONI'`. No Awka driver is rung.

**FAIL — roll back Awka immediately:** Onitsha requests slow down, find fewer
drivers, or reach an Awka driver.

This is the single most important test on the page. Awka is upside; Onitsha is
the business.

### 4 · The two pools do not mix

**Do:** Driver A online in Awka, Driver B online in Onitsha. Request one ride
from each city, close together in time.

**PASS:**
- The Awka request rings A and never B.
- The Onitsha request rings B and never A.
- Both rides carry the correct `zoneCode`.

**FAIL:** either driver's phone rings for the other city's ride.

### 5 · A driver who travels becomes eligible where he actually is

**Do:** Driver B drives from Onitsha to Awka (or A the other way). Once he has
arrived and the app has reported a fresh position, request a ride in the city he
is now in.

**PASS:** he receives it, and his `driver_profile.homeZoneCode` is irrelevant —
check that it still says the *old* city and he was offered the ride anyway.

**FAIL:** he is refused work in the city he is standing in, or he is still
being offered rides in the city he left.

Query while he travels:

```sql
-- what the platform thinks his live position is
SELECT "userId", "homeZoneCode" FROM driver_profile WHERE "userId" = '…';
```
```
redis-cli GEOPOS drivers:locations <driverId>
redis-cli TTL driver:available:<driverId>     -- >0 means his fix is under 45s old
```

### 6 · Backgrounded phones still get the ride

**Do:** Both driver phones: screen off, app backgrounded, left alone for **at
least 5 minutes** so the availability key expires. Then request an Awka ride.

**PASS:** the Awka driver's phone rings audibly from a cold background within
~60 s and, on opening, shows the offer.

**FAIL:** silence; or it rings but the offer is gone by the time he opens it.

This tests the wake path, which is the single most common way a working
dispatch system still fails to reach a driver.

### 7 · Out-of-coverage is honest

**Do:** Have someone outside both cities — Nnewi, Asaba, or anywhere on the
Onitsha–Awka road between the two — request a ride.

**PASS (while enforcement is `off`/`observe`, which is launch day):**
- `SELECT "zoneCode" FROM ride …` → `NULL`, `zoneMatchKind = 'none'`
- A row appears in `service_area_miss` with `refused = false`
- The passenger gets the ordinary "no driver found" experience — **not** an
  error, and **not** a driver from another city.

**FAIL:** a driver in Onitsha or Awka is rung for it.

Note what this test is *not*: while enforcement is off, nobody is refused. That
is deliberate. Refusal is a later, separate decision and needs an app release
first.

### 8 · Operations can explain what happened

**Do:** In the Operations console, open the queue, then open each of the rides
above and take control of one.

**PASS:**
- Every queued ride carries a city chip — **Onitsha** or **Awka**, in words.
- The out-of-coverage ride from test 7 reads **Outside service areas**, in red,
  and is visibly different from an old ride that reads *Zone not determined*.
- Taking control of an Awka ride shows **Drivers for Awka** above the list.
- Each driver carries their own current geography: **Onitsha**, **Awka**,
  **Outside service areas**, or **Location stale** — and a driver with no live
  fix reads *Location stale*, never a city name.
- An operator can answer both questions without calling an engineer:
  *why did this ride go to this driver?* and *why was this request not
  dispatched?*

**FAIL:** any ride shows no city; a driver with a stale fix is labelled with a
city; an operator has to guess.

### 9 · A cross-city assignment is visible — and, under enforcement, refused

**Do:** Take control of an Awka ride. Find an Onitsha driver in the list
(category ALL).

**PASS, on launch day (`observe`):** the driver row reads **Onitsha** in amber
against an Awka ride. Assign is still available — the platform genuinely allows
it while nothing enforces, and the console must not invent a restriction that
was never switched on. The operator can see exactly what they are doing.

**PASS, later (`enforce`):** the same row reads **Onitsha**, Assign is disabled,
and the reason under the name says *Not in Awka — cannot be assigned to this
ride.* Attempting it through any other means is refused by the server with
`DRIVER_OUTSIDE_RIDE_ZONE`.

**FAIL:** the driver's city is not shown; or under enforcement the button is
offered and the assignment then fails.

---

## Go / no-go

Awka goes public when **tests 1, 2, 3, 4, 6 and 8 pass.**

- Test 3 failing is a **rollback**, not a fix-forward. Take Awka dark first, then
  diagnose.
- Test 5 failing is a launch blocker only if drivers cannot work in Awka at all;
  if it is only the reciprocal direction, launch and fix.
- Test 7 failing is a day-two problem, so long as its real failure mode —
  cross-city dispatch — did not occur.
- Test 9 is informational on launch day: while nothing enforces, its job is to
  confirm the operator can SEE geography, not that the platform blocks anything.

Write the result of each test down as you go, with the `rideId`. The rows are
the evidence; memory of a launch day is not.
