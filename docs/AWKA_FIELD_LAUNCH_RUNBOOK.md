# Awka field launch runbook

One document, used with phones in hand. Everything is prepared; nothing here
needs a code change.

**Two facts to keep straight all day:**

1. **Activating Awka and enforcing geography are separate decisions.** Launch
   activates Awka. Enforcement stays off. Nobody is refused a ride on launch day.
2. **Rollback is one command and cannot touch Onitsha.**

Certified baseline: [`AWKA_LAUNCH_BASELINE.md`](AWKA_LAUNCH_BASELINE.md) ·
Detailed tests: [`field_test_awka_launch.md`](field_test_awka_launch.md)

---

> **One thing to set up first.** Every command below runs inside the live API
> container, and blue-green means the live colour alternates with each deploy.
> Resolve it once per SSH session and reuse it:
>
> ```
> ssh root@206.189.96.147
> LIVE=$(docker ps --format '{{.Names}}' | grep -E '^api_prod_(blue|green)$' | head -1)
> echo $LIVE          # sanity check: api_prod_blue or api_prod_green
> ```
>
> The commands here are written as `ssh root@... 'docker exec $LIVE ...'`, which
> resolves on the droplet — so they also work pasted from your laptop if you set
> `LIVE` inside the same quoted command:
> `ssh root@206.189.96.147 'LIVE=$(docker ps --format "{{.Names}}" | grep -E "^api_prod_(blue|green)$" | head -1); docker exec $LIVE npm run --silent zone:status:prod'`

## A. Before leaving for Awka

- [ ] **Take these:** 1 passenger Android phone · 3 driver Android phones
      (A, B, C) · laptop with SSH access to `206.189.96.147` · phone charger
      / power bank · two SIMs on different networks if possible
- [ ] All four phones on the **current Play builds** — passenger `1.5.0+32`,
      driver `1.5.0+50`. Do **not** side-load anything.
- [ ] All three driver accounts **approved with complete KYC** (including the
      selfie) — check in Admin before you travel. A driver stuck on KYC in Awka
      is a wasted trip.
- [ ] The passenger test account can log in and has a working wallet or is set
      to cash.
- [ ] Laptop can reach the console: `https://api.kekeride.ng/dispatcher/`
      and you can log in as a dispatcher.
- [ ] Confirm the baseline is still what the record says:
      ```
      ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:status:prod'
      ```
      Expect **ONI active/observe · AWK draft/off · enforcing zones 0**.
- [ ] `curl -s https://api.kekeride.ng/health` returns `status: ok`.

---

## B. Arrival in Awka

- [ ] Stand somewhere central — **Aroma Junction** is the reference point.
- [ ] All four phones on mobile data, GPS on, **High accuracy** location mode.
- [ ] Open the passenger app; confirm the map finds you and the pin is roughly
      where you are standing.
- [ ] Three driver phones logged in and set **ONLINE**.
- [ ] Laptop: dispatcher console open on the live queue.

---

## C. Pre-activation test

Awka is still `draft`. This section proves the *phones* work before you change
anything on the platform — so that if something fails, you know it is the
handset and not the launch.

- [ ] **C1 · Passenger GPS resolves in Awka.** Passenger map centres on your
      real position, pin within ~50 m.
- [ ] **C2 · The pickup is genuinely in the drawn zone.** On the laptop:
      ```
      ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:probe:prod -- --lat=<YOUR LAT> --lng=<YOUR LNG>'
      ```
      While AWK is draft this correctly says **OUTSIDE, nearest ONI**. What you
      are checking is the *coordinate*: it must be inside the Awka bounding box
      (lat 6.176–6.268, lng 7.026–7.145). If it is not, you are outside the
      launch polygon — move toward Aroma Junction.
- [ ] **C3 · Drivers A, B and C appear ONLINE** in the dispatcher console with
      a fresh position and a sensible distance.
- [ ] **C4 · Do NOT request a ride yet.** Awka is not open; a request now is
      expected to find nobody.

**If C1 or C3 fails, stop.** That is a handset or network problem and
activating Awka will not fix it.

---

## D. Activate Awka

One command. It changes `status` only, and leaves enforcement alone.

- [ ] **Dry run first** (changes nothing, prints the plan):
      ```
      ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:activate:prod -- --code=AWK'
      ```
- [ ] **Apply:**
      ```
      ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:activate:prod -- --code=AWK --apply'
      ```

**Expect, in the output:**

```
  status                 draft  →  active
  enforcement            off  (unchanged — see below)

  APPLIED
  status                 active
  enforcement            off
  enforcing zones        0
```

**Expect in the logs** — one audit line, which is the record of who opened the city:

```json
{"level":"info","scope":"service_zone","event":"zone_mode_changed","zoneCode":"AWK",
 "before":{"status":"draft","enforcement":"off"},
 "after":{"status":"active","enforcement":"off"}}
```

- [ ] **Cache.** The command busts the cache in the process that ran it; every
      other process picks the change up within **60 s**. Wait a minute before
      concluding anything failed.
- [ ] **Postgres:** one row changed — `service_zone` where `code='AWK'`.
      Nothing else is written.
- [ ] **Redis:** unchanged. Zones do not live in Redis at all.
- [ ] **Verify classification** — re-run the probe from C2. It must now say:
      ```
      resolves to    AWK (exact)
      coverage       in_zone
      would refuse?  no
      ```
- [ ] **Verify the console** shows an **Awka** chip on the next Awka request.

**Rollback, if anything above is wrong** — see section I.

---

## E. Controlled ride test

Work through [`field_test_awka_launch.md`](field_test_awka_launch.md) for the
detail. This is the short form; tick as you go and write the `rideId` beside
each one.

Every row: do the **action**, check the **expected result**, tick PASS or FAIL,
and if it fails capture what the last column says **before moving on**.

| # | Action | Expected result | P/F | If FAIL, capture |
|---|---|---|---|---|
| 1 | Open passenger app, let the map settle | Pin within ~50 m of where you stand | ☐ | Screenshot of the map; the lat/lng the app shows; whether location mode is High accuracy |
| 2 | Request preview, then read the ride row | `zoneCode = AWK`, `zoneMatchKind = exact` | ☐ | `rideId`; run `zone:probe:prod` on the exact pickup coords and save the output |
| 3 | Driver A → ONLINE | Console: ONLINE, chip **Awka**, live distance | ☐ | Screenshot of the driver row; `redis-cli TTL driver:available:<id>` |
| 4 | Driver B → ONLINE | Same | ☐ | Same as 3 |
| 5 | Driver C → ONLINE | Same | ☐ | Same as 3 |
| 6 | Passenger requests a ride | Request accepted, searching starts | ☐ | `rideId`; passenger screenshot; backend log for that ride |
| 7 | Watch which phones ring | Nearest Awka driver rings; **no Onitsha driver rings** | ☐ | `rideId`; which driver ids rang; console driver list screenshot |
| 8 | Driver app in foreground | Offer card within ~10 s | ☐ | `rideId`; time from request to card; driver id |
| 9 | Driver app backgrounded | Notification within ~30 s | ☐ | Handset make/model + Android version; battery optimisation setting; time waited |
| 10 | Driver phone screen locked | Audible notification on the lock screen | ☐ | Handset model; notification channel settings; DND state |
| 11 | Phone idle ≥5 min, screen off | Still rings within ~60 s | ☐ | Handset model; exact idle time; whether the app was swiped away |
| 12 | Driver accepts | `accepted`, exactly one driver wins | ☐ | `rideId`; both driver screens; ride status in the console |
| 13 | Look at the passenger phone | Driver name, plate, photo, ETA | ☐ | Passenger screenshot; which field is missing |
| 14 | Driver drives toward pickup | Marker moves, ETA falls | ☐ | `rideId`; how long the marker was frozen; driver GPS permission |
| 15 | Driver taps Arrived | `arrived`; passenger is told | ☐ | `rideId`; both screens; distance from the pin |
| 16 | Start the trip | `in_progress` | ☐ | `rideId`; the pickup code entered; the error shown |
| 17 | Drive ≥1 km | Remaining distance falls | ☐ | `rideId`; screenshots at two points; route shown |
| 18 | End the trip | `completed`; both phones show the same fare | ☐ | `rideId`; both fare figures; which one disagrees |
| 19 | Check the money | Commission = fare − fare/1.1 (₦1,100 → ₦100) | ☐ | `rideId`; fare; driver wallet before/after; ledger rows |
| 20 | Open the ride in Operations | **Awka** chip present start to finish | ☐ | `rideId`; console screenshot; what the chip said instead |
| 21 | Second ride, driver B | Same result, end to end | ☐ | `rideId`; which step differed from ride 1 |
| 22 | Passenger cancels a third request | Both phones agree; no ghost ride | ☐ | `rideId`; both screens; ride status in the console |
| 23 | Driver calls the passenger | Call connects; Operations can reveal on request | ☐ | `rideId`; the exact message shown; staff role used |
| 24 | Watch notifications all trip | Push at accept, arrive, start, complete | ☐ | `rideId`; which lifecycle events produced nothing |
| 25 | Onitsha ride during this window | Behaves exactly as before Awka opened | ☐ | Onitsha `rideId`; time to first offer vs normal; which driver was rung |

**Test 25 is not optional and cannot be done from Awka alone** — arrange for
somebody in Onitsha to request an ordinary ride during this window, or check the
console for organic Onitsha traffic behaving normally.

### E-M · Driver mobility (do this one deliberately)

The KekeRide product principle: a driver works where they **are**, not where
they registered.

- [ ] Use a driver account whose `homeZoneCode` is **ONI** — one of your three
      phones, or check in Admin which it is.
- [ ] That driver is physically in Awka, app ONLINE, fresh GPS.
- [ ] Request an Awka ride.
- [ ] **Expected under the approved policy: he IS eligible and CAN be
      dispatched.** Home zone grants nothing and withholds nothing; eligibility
      is decided by live position alone. He becomes Awka-eligible the moment the
      heartbeat carrying his first Awka fix lands — no settling period.
- [ ] Confirm in the console: driver row reads **Awka**; his profile still says
      home zone ONI.
- [ ] **Write down the actual result**, pass or fail. This is a product claim,
      not just a technical one.

### E-O · Outside-coverage observation (no travel required)

- [ ] From the laptop, probe a coordinate far outside both cities — read-only,
      creates nothing:
      ```
      ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:probe:prod -- --lat=12.0363 --lng=8.4731'
      ```
- [ ] **Expected:** `OUTSIDE — nearest ONI, ~666 km`, `coverage out_of_coverage`,
      **`would refuse? no`** (enforcement is off), and the sentence enforcement
      *would* have used.
- [ ] Repeat for a point between the cities, e.g. `--lat=6.19256 --lng=6.95336`.
      Expected `OUTSIDE` — the corridor belongs to **neither** city, not to
      whichever is nearer.
- [ ] Do **not** enable enforcement to test this.

---

## F. Go / no-go decision

### CRITICAL NO-GO — do not launch, roll back Awka

- [ ] Awka pickups classify as anything other than `AWK`
- [ ] Drivers cannot go ONLINE, or never appear as available
- [ ] Ride requests fail outright
- [ ] A driver in the wrong city is offered or assigned an Awka ride
- [ ] Background or locked-screen notification fails **materially** — tests 9,
      10 or 11 fail on more than one handset
- [ ] The ride lifecycle breaks (cannot arrive, start, or complete)
- [ ] Any wallet or payment corruption: wrong fare, wrong commission, duplicate
      or missing ledger entries
- [ ] Operations cannot tell an Awka ride from an Onitsha one
- [ ] **Any Onitsha regression at all**
- [ ] Backend instability — health failing, errors in the log, latency far above
      the ~0.5 s baseline
- [ ] Redis or Postgres inconsistency

### FIX BEFORE PUBLIC LAUNCH — Awka may stay active for controlled testing

- [ ] Notification is slow but arrives (30–90 s) on one handset only
- [ ] The boundary is slightly tight — real pickups just outside it (visible as
      `service_area_miss` rows with `nearestZoneCode = AWK` and a small distance)
- [ ] Cancellation leaves a stale card that a refresh clears
- [ ] Contact reveal is awkward but works
- [ ] Fares are right but ETAs are poor

### NON-BLOCKING OBSERVATION — note it, launch anyway

- [ ] The driver map's initial camera is 33 km west of Onitsha before the first
      fix (known, cosmetic)
- [ ] Address strings read poorly ("Unnamed Road")
- [ ] Map labels, icons, copy, spacing
- [ ] Landmark suggestions could be better tuned for Awka

**Do not classify a cosmetic issue as a launch blocker.**

**Launch when:** tests 1, 2, 6, 7, 8, 9, 12, 13, 18, 19, 20 and 25 pass, plus at
least two of 10 / 11 across different handsets.

---

## G. Public launch

- [ ] Go/no-go above is a GO.
- [ ] At least **two complete real rides** finished with correct money.
- [ ] Onitsha unaffected (test 25).
- [ ] Confirm the posture is still what you intend:
      ```
      ... zone:status:prod
      ```
      Expect **AWK active/off · ONI active/observe · enforcing zones 0**.
- [ ] **Enforcement stays off.** Do not change it today.
- [ ] Tell the drivers Awka is live.
- [ ] Begin section H.

---

## H. First-hour monitoring

Run this from the laptop. Read-only.

```
ssh root@206.189.96.147 'docker exec $(docker ps --filter name=postgres --format "{{.Names}}" | head -1) \
  psql -U postgres -d keke_prod_db -t -A -F"|" \
  -c "select coalesce(\"zoneCode\",'"'"'NONE'"'"') zone, status, count(*) from ride where \"createdAt\" > now() - interval '"'"'1 hour'"'"' group by 1,2 order by 1,2;" \
  -c "select count(*) from service_area_miss where \"createdAt\" > now() - interval '"'"'1 hour'"'"';"'
```

### First 15 minutes — after every ride

- [ ] Each Awka ride carries `zoneCode = AWK`
- [ ] Candidates found > 0 on every request
- [ ] The offer reached a handset
- [ ] Acceptance worked
- [ ] `curl -s https://api.kekeride.ng/health` → `ok`, db up, redis up
- [ ] No Onitsha ride has an Awka driver, or the reverse

### First hour

- [ ] Requests, and how many were classified `AWK` vs `NONE`
- [ ] Assignment rate — accepted ÷ requested
- [ ] Completion and cancellation counts
- [ ] Driver availability: `redis-cli --scan --pattern "driver:available:*" | wc -l`
- [ ] Location freshness — every dispatched driver had a live key
- [ ] Backend errors: `docker logs api_prod_green --since 1h | grep '"level":"error"'` → empty
- [ ] Latency still ≈0.5 s
- [ ] Wallet: commission ≈ 9.09% of gross on every completed ride
- [ ] **Onitsha volume compared with the same hour yesterday**

### First 6 hours

- [ ] Any `service_area_miss` row with `nearestZoneCode = AWK` and distance
      < 1 km → the boundary is slightly tight. Note it; it is a polygon edit,
      not an incident.
- [ ] No cross-zone anomaly of any kind
- [ ] Redis key count stable, Postgres connections stable
- [ ] Driver complaints about not receiving requests

### First 24 hours

- [ ] Awka rides completed, and the completion rate versus Onitsha's
- [ ] Full wallet reconciliation: `npm run wallet:reconcile:prod`
- [ ] `zone:status:prod` still reads AWK active/off · ONI active/observe · 0 enforcing
- [ ] Demand clusters outside the polygon — where the next boundary edit should go
- [ ] Decide: keep Awka live, adjust the boundary, or roll back

---

## I. Emergency rollback

**One command. It cannot touch Onitsha.**

```
ssh root@206.189.96.147 'docker exec $LIVE npm run --silent zone:rollback:prod -- --code=AWK --apply'
```

**What it does:** sets AWK to `draft` / `off`. One row in `service_zone`.

**What happens, precisely:**

| | |
|---|---|
| **New Awka requests** | stop classifying as `AWK` within 60 s; they resolve `outside`, find no driver, and the passenger gets the ordinary "no Keke nearby" experience. Nobody is shown an error. |
| **A ride already in progress** | **completes normally.** A ride carries the `zoneCode` it was born with for its whole life. Nothing re-reads the zone table mid-trip: arrival, start, completion, fare, commission and payment all proceed unchanged. |
| **A ride still searching** | keeps searching against whatever drivers are live, then times out normally if nobody accepts. It is not cancelled by the rollback. |
| **Onitsha** | untouched. The command reads and writes one row, selected by code. Proven by test *ROLLBACK — AWK can be taken dark again WITHOUT disturbing ONI*, which compares the whole Onitsha dispatch result either side. |
| **Data** | nothing deleted. No ride, driver, wallet, ledger entry or account is modified. |
| **Schema** | untouched. There is no migration to revert, and you must not revert one. |
| **Drivers** | stay approved, stay online, keep any ride they are on. They simply stop receiving new Awka requests. |

**To re-activate later:** the activate command from section D. It is symmetric
and can be repeated safely.

### If the problem is bigger than Awka

- **Both cities misbehaving on geography** — set `SERVICE_ZONES_ENABLED=false`
  and deploy. Every path then behaves exactly as it did before service zones
  existed. This needs a deploy on purpose, so it cannot be flipped and forgotten.
- **The backend itself is bad** — `infra/rollback.sh` re-points nginx at the
  previous colour. That is a different problem from Awka, and a different lever.

---

## J. Post-launch 24-hour monitoring

- [ ] **T+2h** — health, error log, Onitsha volume, Awka completion rate
- [ ] **T+6h** — full first-6-hours list in section H
- [ ] **T+12h** — wallet reconciliation; any commission anomaly
- [ ] **T+24h** — the full first-24-hours list; write down the decision
- [ ] Record: Awka rides requested / classified AWK / completed / cancelled
- [ ] Record: any `service_area_miss` near the Awka boundary, with distances
- [ ] Record: driver feedback on notification reliability — this is the number
      that decides whether we need a driver app release
- [ ] Only after 24 clean hours, consider the next decisions:
      **boundary adjustment**, **passenger release adoption**, and — separately,
      later, and never on launch day — **enforcement**.
