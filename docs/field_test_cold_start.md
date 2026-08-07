# 5-minute field test: cold-start active-ride recovery

Install `build_output/keke_passenger_fieldtest_1.4.1-31.apk` on the passenger
phone. Driver phone can stay on its current build.

This APK is built against **production** (`api.kekeride.ng`) with a working
Maps key, and shows a black diagnostics strip at the top.

---

## The test

**0:00 — Book.** Passenger books, driver accepts. Confirm the passenger sees the
driver.

**0:30 — Read the strip.** Tap it to expand:

```
auth        success 40ms token_valid
token       skipped present          ← was the request authenticated
api         success 380ms found accepted
attempt     #1
last error  —
ride?       found
```

**1:00 — Force-close.** Swipe KekeRide away from recent apps. Confirm the
process is gone, not backgrounded.

**1:15 — Cold open.** Launch from the launcher icon.

**Watch the strip while the restoring screen shows.** This is the whole test:

| Line | Expected | If wrong |
|---|---|---|
| `auth` | `success … token_valid` | `token_expired` → session died, you'd be on /welcome |
| `token` | `present` | `absent` → request went out unauthenticated |
| `api` | `started` then `success … found accepted` | see below |
| `attempt` | `#1`, maybe `#2` | climbing past ~5 means it keeps failing |
| `last error` | `—` | the real reason, **not** "offline" |

**Expected result: the ride screen appears within a few seconds.**

**1:45 — If it sticks**, note `last error` and `attempt`. That single word is
the diagnosis:

| `last error` | Meaning |
|---|---|
| `unauthorised` (+ http 401) | Session rejected by the server |
| `timeout` | Server reached, did not answer |
| `unreachable` | DNS/TCP failed — often WiFi connected with no uplink |
| `offline` | No network interface |
| `serverError` (+ http 5xx) | Backend fault |
| `malformedResponse` | Server answered, body unusable |
| `inFlight` | A lock problem — this is the bug that was fixed |

Then press **Try again** on the screen. It should force a fresh attempt.

**2:30 — Repeat while in-progress.** Have the driver start the trip, then
force-close and cold-open again. Expect the active-trip screen.

**3:30 — Airplane-mode variant.** Turn on flight mode, cold-open the app. It
should show the restoring screen with `last error` = `offline`/`unreachable` and
**attempt climbing**. Turn flight mode off — it must recover on its own within
about 15 seconds without you pressing anything.

**4:30 — Done.** Photograph the strip if anything failed.

---

## What was wrong before

Four separate ways the screen could hang forever, all fixed:

1. The in-flight lock could latch `true` permanently if a state write threw, so
   no request was ever made again.
2. The retry chain could die silently when two callers overlapped.
3. `rideRestoreFailed` was never cleared after success, so the retry loop ran
   for the rest of the ride.
4. `(data['pickupLat'] as num?)` is a CAST — it throws on a String, and one bad
   coordinate discarded the whole ride.

Plus: every failure rendered as *"We can't reach KekeRide right now"*, which is
why a phone with full signal looked like a network problem.
