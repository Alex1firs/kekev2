# Ride Lifecycle Hardening Report

Audit of every path where the app process or the network can disappear during a
live ride, across the passenger app, the driver app and the backend.

Method: read the code, then prove the conclusion with a test. Where a conclusion
could not be proved in this environment it is marked **UNVERIFIED** and appears
in the risk register rather than being claimed as safe.

**Regression at time of writing:** backend 696 unit + 22 concurrency, driver
112, passenger 223. Dispatch, socket handler, auth, payments and wallets have an
empty diff across this work.

---

## 1. The central invariant

> **"We could not ask the server" must never be treated as "there is no ride."**

Every serious defect found in this audit was a variation on collapsing those two
into one branch. The passenger app did it and stranded passengers. The driver
app did it and put drivers who were still carrying passengers back into the
available pool.

Both apps now model three outcomes — `found` / `none` / `failed` — and `failed`
keeps the current screen, blocks the action that would compound the error, and
retries.

---

## 2. Scenario matrix

Legend: **OK** already correct · **FIXED** this pass · **MITIGATED** contained
elsewhere · **LIMIT** a platform limitation, documented in §5

| # | Scenario | Expected | Was | Now |
|---|---|---|---|---|
| 1 | Passenger force-closes app | Ride restored from server | Booking screen + "Something went wrong" | **FIXED** |
| 2 | Driver force-closes app | Ride restored, driver stays busy | Restored, but lost on any parse error; failure → driver went Online | **FIXED** |
| 3 | Passenger phone restarts | Same as 1 | Same as 1 | **FIXED** |
| 4 | Driver phone restarts | Same as 2 | Same as 2 | **FIXED** |
| 5 | OS kills process (memory) | Indistinguishable from force-close | Same as 1 / 2 | **FIXED** |
| 6 | Internet disappears | Keep ride on screen, say so | Passenger: destructive error. Driver: error banner | **FIXED** |
| 7 | Internet returns | Re-read server, reconcile | Passenger: only if rideId in memory. Driver: partial | **FIXED** |
| 8 | WebSocket disconnects | Reconnect, rejoin ride room, re-read | Ride room was **never joined** in either app | **FIXED** |
| 9 | Firebase token refreshes | Token re-registered; ride unaffected | Correct — token registration is independent of ride state | **OK** |
| 10 | Log out then back in | No stale ride; recovery on new session | Controller rebuilds on auth change; recovery runs | **OK** |
| 11 | Play Store upgrade mid-ride | Process death → recovery | Same as 5 | **FIXED** |
| 12 | Backend restarts | Sockets reconnect, state re-read | Socket auto-reconnect + resume triggers | **OK** |
| 13 | Blue-green deploy mid-ride | No interruption | Verified: 0 failed requests, socket survived cutover + drain, 1.5 s reconnect | **OK** |
| 14 | Passenger changes device | Ride follows the account | Server keys on `passengerId`; new device recovers | **OK** |
| 15 | Driver changes device | Ride follows the account | Server keys on `driverId`; new device recovers | **OK** |
| 16 | GPS permission revoked | Ride unaffected; prompt to restore | Passenger recovery no longer sits behind a location call | **FIXED** |
| 17 | Notification tapped after death | Verify with server, then render | Passenger re-read but partially; both now verify | **FIXED** |
| 18 | Driver offered 2nd ride mid-trip | Impossible | Excluded by `DriverEligibilityService` | **MITIGATED** |
| 19 | Duplicate accept | Impossible | Conditional `UPDATE ... WHERE status='searching'` | **OK** |
| 20 | Android kills a backgrounded driver | Presence expires; driver recovers on reopen | Redis presence TTL; recovery on resume | **LIMIT** |
| 21 | iOS suspends the app | Socket drops; recovery on resume | Resume triggers recovery | **LIMIT** |

---

## 3. Defects found and fixed

### 3.1 Passenger — recovery entangled with map setup *(previous session)*

Two half-implementations. `_initializeMap()` held a partial restore that ran
after `await getCurrentLocation()` and after the booking screen had been
painted; it dropped `driverDetails` and `coordination`, and turned any exception
into `RideOutcome.serverFailed`. `syncStatus()` was complete but began
`if (state.rideId == null) return;` — a no-op after process death.

### 3.2 Driver — `double.parse` with no null guard

```dart
pickupLocation: LatLng(
    double.parse(rideData['pickupLat'].toString()),   // throws on null
    double.parse(rideData['pickupLng'].toString())),
```

Four unguarded parses. One missing coordinate threw, and the catch turned a live
ride into `errorMessage: 'Could not restore your active ride'`. The driver lost
a trip they were in the middle of.

Test: *"missing coordinates still restore the ride"*.

### 3.3 Driver — a failed check took the driver Online

`_maybeAutoResumeOnline()` guards on `operationStatus != offline`. Recovery set
`busy` on success — but on **failure** the status stayed `offline`, which
auto-resume read as "free", and the driver was advertised as available while
still carrying a passenger.

**Contained server-side**, which is why this is High and not Critical:
`DriverEligibilityService` excludes `already_on_active_ride` and the accept path
returns `ACTIVE_RIDE_EXISTS`. The driver could not actually be double-assigned —
they simply believed they were working and received nothing.

Fixed: `_activeRideUnresolved` blocks auto-resume until the question is settled.
Test: *"a driver whose recovery failed is never treated as free"*.

### 3.4 Both apps — the ride room was never joined

`SocketService.updateActiveRide()` registers `_activeRideId`, which
`_initSocket()` re-joins on every reconnect. In the passenger app it had **zero
callers**; in the driver app it was called on live assignment but **not on
recovery**. A restarted driver sat in the driver room only and missed passenger
chat, cancellations and coordination for the rest of the trip.

Both also wrote `_socket!.emit(...)` directly, bypassing the public `emit()` —
so the offline test double never recorded it and the behaviour was untestable.

Tests: *"the ride room is rejoined so realtime resumes"* in both apps.

### 3.5 Driver — recovery nested inside the profile fetch

Recovery lived inside the success branch of `GET /drivers/status/:id`. A profile
fetch that failed — slow network, 500 — meant **no ride recovery at all**. The
two are independent questions and are now asked independently, from the
constructor.

Found by a test that stubbed only the active-ride endpoint and watched the ride
fail to restore.

### 3.6 Driver — passenger identity lost on recovery

`passengerName: 'User', // Generic placeholder for recovery` — and no phone. The
backend returns `passengerContact` on this endpoint *specifically* so a
restarted driver can still call their passenger; recovery ignored it.

Test: *"the passenger name and phone are restored, not a placeholder"*.

### 3.7 Backend — `started` missing from the busy set

`DRIVER_BUSY_RIDE_STATES` omitted `'started'` while both recovery endpoints
include it. **Not a live gap** — verified that nothing persists that status;
trip-start writes `in_progress` and only *broadcasts* `'started'` to match the
passenger UI's expected string. But `RideStatus.STARTED` exists and several read
paths accept it, so a future write would have silently disabled the exclusion.
Added defensively with a contract test.

---

## 4. Regressions introduced during this work, and caught

Recorded because they are the sharpest evidence that the tests are load-bearing.

1. **Fresh pending offers would have been wiped.** Collapsing the driver's
   "no active ride" handling into one branch discarded an offer the driver had
   not yet accepted — those are still `searching` server-side and invisible to
   `/rides/active/driver`. Symptom: driver hears the alert, no screen appears.
   The original three-way distinction is restored and now tested.
2. **`_calculateFare()` during passenger recovery** cleared the server's
   authoritative fare and raised an `invalidRoute` banner over a healthy trip.
   Replaced with a polyline-only redraw that fails silently.
3. **Clearing on `none` wiped the passenger's chosen route** when a booking was
   refused, because a client-minted rideId exists while searching. Narrowed to
   the tracking states.
4. **A recovery-failure message clobbered specific errors** the driver was
   reading. Recovery now fails silently; the consequence surfaces where it
   matters, at Go Online.

---

## 5. Platform limitations — not bugs

These cannot be fixed in application code and are listed separately, as asked.

### Android

- **The persistent ride notification cannot update while the process is dead.**
  Android owns the posted notification, so it survives a force-close and stays
  tappable — but its text freezes at the last state the app knew. An FCM
  lifecycle push corrects it; otherwise it is corrected the moment the passenger
  opens the app. Treat it as a way back in, never as truth.
- **A backgrounded app can be killed at any time.** No amount of application
  code prevents it. What is guaranteed is that reopening restores the ride from
  the server. A driver killed while Online stops sending heartbeats; their Redis
  presence expires and dispatch stops considering them — correct behaviour, but
  it means *a killed driver silently leaves the pool until they reopen the app*.
- **No persistent ride notification.** The apps depend on `firebase_messaging`
  only; there is no local-notification plugin. A passenger with the app closed
  learns of driver arrival only from a push. Adding this needs
  `flutter_local_notifications` plus core-library desugaring.
- **Battery optimisation** can defer FCM delivery indefinitely on some OEM
  builds (Xiaomi, Oppo, Vivo are the usual offenders in this market). The driver
  app already detects and warns about this (`BatteryOptimizationService`); the
  passenger app does not.

### iOS

- **Suspension drops the socket within seconds** of backgrounding. Recovery on
  resume is the mitigation and it works, but a passenger whose app is suspended
  gets no live updates until they return.
- **Live Activities are not available**: deployment target is **14.0**
  (`Podfile` and both build configs); ActivityKit needs **16.1+**, plus a Widget
  Extension target that does not exist.
- **Background location for drivers** is limited without an `always`
  authorisation and the background-modes entitlement.

---

## 6. Risk register

### Critical
*None outstanding.* The two candidates were both contained: duplicate accept is
arbitrated by a conditional `UPDATE` in Postgres, and double-dispatch by
`DriverEligibilityService`.

### High

| Risk | Why it matters | Mitigation |
|---|---|---|
| **No persistent ride notification (Android)** | A passenger with the app closed does not know their driver arrived unless a push lands. Highest-frequency real-world complaint. | Add `flutter_local_notifications`; needs a device to test. |
| **Neither app is released** | Every fix in this report is in the repository, not on a passenger's phone. | Store release. |
| **OEM battery optimisation defers push** | A driver can miss ride offers entirely and appear unreliable. | Driver app warns; passenger app does not. |

### Medium

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Recovery retry is a fixed 4 s, unbounded** | A phone offline for an hour retries every 4 s, costing battery. | Add exponential backoff and a ceiling. |
| **Analytics never leave the device** | `AnalyticsService` prints to console. Client-side recovery telemetry is invisible to operations. | Backend logs cover every recovery (each *is* an endpoint call); a client sink would add the failures that never reach the server. |
| **In-flight dispatch runs die with the old colour** | A deploy during an active search can lose a dispatch run after the 180 s drain. | Unchanged by this work; rare. |
| **No end-to-end device test** | Recovery is proven at controller level; no test drives a real cold start on a handset. | Needs a staging ride and a device. |

### Low

| Risk | Mitigation |
|---|---|
| Passenger app has no battery-optimisation warning | Mirror the driver implementation |
| `'started'` exists as a status nothing writes | Now defended; consider removing the enum value |
| Recovery redraws the route with a second directions call | Cosmetic; fails silently |
| Driver `errorMessage` is a single slot; messages can overwrite | Queue or prioritise |

---

## 7. Evidence index

**Files inspected:** `booking_controller.dart`, `booking_state.dart`,
`socket_service.dart` (both apps), `main.dart`, `app_router.dart`,
`auth_guard.dart`, `api_client.dart`, `notification_service.dart` (both apps),
`driver_controller.dart`, `driver_profile.dart`, `trip_request.dart`,
`ride_routes.ts`, `socket_handler.ts`, `driver_eligibility_service.ts`,
`Ride.ts`, `stale_ride_service.ts`.

**Files changed this pass:**

| File | Change |
|---|---|
| `keke_driver/.../active_ride_recovery.dart` | New — the single driver recovery path |
| `keke_driver/.../driver_controller.dart` | Recovery decoupled from profile fetch; `syncStatus` delegates; auto-resume guarded; ride room joined; `debugSetOffer` |
| `keke_driver/core/network/socket_service.dart` | `updateActiveRide` routed through `emit` |
| `keke_backend/.../driver_eligibility_service.ts` | `started` added defensively |
| `keke_driver/test/active_ride_recovery_test.dart` | New — 22 tests |
| `keke_driver/test/driver_lifecycle_recovery_test.dart` | New — 9 tests |
| `keke_backend/test/unit/ride_lifecycle_contract.test.ts` | New — 7 tests |

**Tests added: 38 (lifecycle) + 51 (notifications).** Cumulative: **127**.

**Android persistent notification — DONE.** Passenger: a new ongoing
notification on the silent `keke_ride_status` channel, deliberately not a
foreground service (see `ride_status_notification.dart` for the reasoning).
Driver: the existing, already-justified foreground service now reflects the trip
instead of reading "KekeRide is online" throughout. Both APKs verified to build;
plugin confirmed compiled into the passenger dex and its manifest merged; no
foreground-service permission added to the passenger app.

**Production safety:** the only backend change is one array entry that makes an
existing exclusion stricter. No migration, no schema change, no change to
dispatch, ride assignment, wallets, payments or authentication.
