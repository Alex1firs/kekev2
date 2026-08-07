# Field test: live in-trip synchronisation

For the road test of the frozen-marker / stuck-ETA / missed-completion fix.

Two phones, one real ride. Budget about 40 minutes including a deliberate
network interruption.

---

## Before you leave

**Install:**

| Phone | APK |
|---|---|
| Passenger | `build_output/keke_passenger_fieldtest.apk` |
| Driver | `build_output/keke_driver.apk` |

The passenger APK is the **field-test build**. A black diagnostics strip appears
at the top of the screen whenever a ride is active. It is not present in an
ordinary build — verified absent from the release binary — so do not ship this
one to anyone.

**Reading the strip.** Three dots, then a detail panel (tap to collapse):

```
FIELD TEST  ● socket  ● room  ● gps
ride        RIDE-1786...
status      started
room        RIDE-1786...        ← "NOT JOINED" here is THE bug
last gps    3s ago              ← should stay under ~15s while moving
last event  3s ago
reconciled  11s ago             ← must never exceed ~25s
driver      6.21093, 7.07401
remaining   1840 m              ← must fall as you drive
eta         8 min
monitor     running             ← "STOPPED" during a ride is a bug
```

Green dots: socket connected · in the ride room · GPS fresh (<30s).
**A red `room` dot during an active ride is the original bug reproducing.**

---

## The run

Tick each. Anything unticked is a finding — note the strip contents.

### 1. Accept and approach
- [ ] Passenger books; driver accepts.
- [ ] Passenger sees driver details and the Keke marker.
- [ ] `room` dot green, `monitor` shows `running`.
- [ ] **Driver drives toward pickup.** Marker moves on the passenger map.
- [ ] `remaining` falls; `eta` falls. Neither sticks.

### 2. Arrival
- [ ] Driver marks arrived; passenger sees the arrived state within seconds.
- [ ] `last gps` still under ~15s.

### 3. Start the trip — the reported failure point
- [ ] Driver starts the trip; passenger flips to the in-progress screen.
- [ ] **`room` dot stays green.** This is the assertion that matters most.
- [ ] Marker keeps moving for at least 3 minutes of driving.
- [ ] `remaining` falls continuously. Note the value every minute:
      `___ m → ___ m → ___ m`
- [ ] `eta` changes at least twice. It must not sit at one number.
- [ ] `last gps` stays under ~15s throughout.

### 4. Deliberate interruption — the actual root cause
Do this **while moving**, mid-trip. This is the scenario that broke.

- [ ] Passenger: turn on flight mode for 20 seconds, then off.
- [ ] Strip shows `socket` red, then recovers.
- [ ] Within ~20s: `room` dot returns to green and `reconciled` resets.
- [ ] **Marker resumes moving.** It must not stay frozen.
- [ ] If a message appears it should read *"Updating your trip…"* — never
      "Something went wrong".

Repeat with the screen locked for 60 seconds:
- [ ] Unlock. Marker and ETA catch up within ~20s.

### 5. Completion
- [ ] Driver ends the trip.
- [ ] **Passenger leaves the in-progress screen within a few seconds.**
- [ ] If the socket event is missed, reconciliation must still move them within
      20 seconds. Time it: `___ s`
- [ ] The persistent ride notification disappears.

### 6. Process death, for completeness
- [ ] Mid-trip, force-close the passenger app (swipe from recents).
- [ ] Reopen. It returns to the trip with the **current** state, not the old one.
- [ ] Marker resumes moving.

---

## If something fails

Photograph the diagnostics strip. It distinguishes the four causes that look
identical on a frozen map:

| Strip shows | Cause | Not |
|---|---|---|
| `room: NOT JOINED` | The room-membership bug | anything else |
| `socket` red, room fine | Passenger connectivity | the driver |
| `last gps` climbing, socket green | **Driver's** phone stopped publishing | the passenger app |
| all green, marker still frozen | A rendering bug | the network |

For the third case, check the driver phone: is it still Online, is the
foreground notification showing the trip, has battery optimisation killed it.

---

## What is being tested

- Root cause: rooms are per-connection, and the shipped build never recorded the
  ride id, so a reconnect dropped the passenger from `ride:<id>` permanently.
- Fix: the id is recorded and re-asserted, plus a 20s reconciliation heartbeat
  and 30s staleness detection for the whole of a live ride.
- ETA/distance: haversine from the live driver position, recomputed on every
  location update. No API call, so it can update as fast as locations arrive.
- Directions are refetched only when the route line is missing or the ride
  changes stage — not on every reconcile.

## Known limits during the test

- The persistent notification's **text** cannot change while the app is dead. It
  updates on the next FCM push or when the app is opened.
- The marker moves in steps as GPS fixes arrive; there is no interpolation yet.
  Judge continuity by whether it *keeps* moving, not by smoothness.
- `driverGpsAgeSeconds` is returned by the backend but is not yet surfaced in
  the passenger UI beyond the diagnostics strip.
