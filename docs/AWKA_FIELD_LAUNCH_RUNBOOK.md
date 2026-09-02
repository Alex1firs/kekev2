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
      ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:status:prod'
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
      ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:probe:prod -- --lat=<YOUR LAT> --lng=<YOUR LNG>'
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
      ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:activate:prod -- --code=AWK'
      ```
- [ ] **Apply:**
      ```
      ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:activate:prod -- --code=AWK --apply'
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

| # | Test | Pass when | Ride id |
|---|---|---|---|
| 1 | Passenger GPS in Awka | pin within ~50 m of where you stand | |
| 2 | Pickup classified AWK | `zoneCode = AWK`, `zoneMatchKind = exact` | |
| 3 | Driver A online | shows ONLINE, **Awka**, live distance | |
| 4 | Driver B online | shows ONLINE, **Awka** | |
| 5 | Driver C online | shows ONLINE, **Awka** | |
| 6 | Passenger requests a ride | request accepted, search starts | |
| 7 | The nearby Awka driver is rung | the closest driver's phone rings; **no Onitsha driver is rung** | |
| 8 | Offer arrives, app foregrounded | card appears within ~10 s | |
| 9 | Offer arrives, app backgrounded | notification within ~30 s | |
| 10 | Offer arrives, screen locked | audible notification on the lock screen | |
| 11 | Cold / background wake | phone idle ≥5 min, screen off → still rings within ~60 s | |
| 12 | Driver accepts | ride moves to `accepted`, exactly one driver wins | |
| 13 | Passenger sees the assignment | driver name, plate, photo and ETA appear | |
| 14 | Location tracking | driver marker moves; ETA falls as they approach | |
| 15 | Driver arrives | `arrived`; passenger is told | |
| 16 | Ride starts | `in_progress` after the pickup code / start action | |
| 17 | Ride moves physically | drive ≥1 km; remaining distance falls | |
| 18 | Ride ends | `completed`; both phones show the same fare | |
| 19 | Fare, wallet, commission | commission = fare − fare/1.1 (₦1,100 → ₦100) | |
| 20 | Operations shows AWK | ride row carries the **Awka** chip, start to finish | |
| 21 | Second controlled ride, driver B | same, end to end | |
| 22 | Cancellation | passenger cancels a third request; both phones agree, no ghost ride | |
| 23 | Contact flow | driver can call the passenger; Operations can reveal on request | |
| 24 | Push through the lifecycle | notifications at accept, arrive, start, complete | |
| 25 | Onitsha still healthy | an Onitsha ride behaves exactly as before | |

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
      ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:probe:prod -- --lat=12.0363 --lng=8.4731'
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
ssh root@206.189.96.147 'cd /opt/kekev2/apps/keke_backend && docker compose exec -T api_prod_green npm run --silent zone:rollback:prod -- --code=AWK --apply'
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
