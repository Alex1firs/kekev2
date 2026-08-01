# Park Dispatch — Physical Acceptance Report

**Status: INCOMPLETE — the physical device test has not been performed.**

**Updated 2026-08-01 (Phase 6):** dispatcher Web Push is now implemented, so the
test matrix below has grown. Two things must happen before the test can run at
all — see §11.

Run date of the automated portions: **2026-08-01**
Environment: local stack on `192.168.1.250:4100`, real PostgreSQL, real Redis,
real Socket.IO.

---

## 0. Read this first

This document has two halves, and conflating them would be the single most
misleading thing anyone could do with it.

**What was actually run** is everything reachable from a machine: the real HTTP
API, real sockets, real Postgres and Redis, and an *emulated* Android device
issuing real touch events over a real LAN.

**What was not run** is the part that needs a person holding a phone in a park.
Nobody has heard the alert. Nobody has installed the app from a home screen.
Nobody has watched what Android's battery optimiser does to the socket at 06:00.

Every row below says which it is. `NOT RUN` does not mean "probably fine".

---

## 1. Test environment

| | |
|---|---|
| Backend | Node/TypeScript, bound to all interfaces on port 4100 |
| Database | PostgreSQL 15 (PostGIS image), `keke_demo` |
| Redis | 7-alpine, port 6399 |
| Dispatcher URL (LAN) | **`http://192.168.1.250:4100/dispatch/`** |
| Dispatcher URL (same machine) | `http://127.0.0.1:4100/dispatch/` |
| Operations dashboard | `apps/keke_admin/index.html` against the same API |
| Park Dispatch | `PARK_DISPATCH_ENABLED=true`, not suspended |

### The one thing that will bite you on the phone

`http://192.168.1.250:4100` is **not a secure context**. Chrome only exempts
`localhost` and `127.0.0.1`. Without a secure context:

- the service worker does not register;
- there is no install prompt and no "Add to Home Screen";
- offline start-up does not work.

The app still loads and runs as an ordinary mobile site — it degrades honestly,
and logs `[pwa] insecure context — service worker not registered` rather than
failing silently.

**SUPERSEDED for the final acceptance test.** The LAN address can be made to
work with `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, and that
is what the emulated run used — but a PWA behaves differently under that flag,
and a test that passes only with it has proved nothing about the real thing.

The final test must use HTTPS: **`https://staging.kekeride.ng/dispatch/`**.
See §11.2. The LAN address remains useful for development and for the
emulated matrix; it is not the acceptance environment.

---

## 2. Identities and park

Created by `scripts/stage_physical_test.ts`. Passwords were generated per run
and written to a file outside the repository; **they are not recorded here and
are not in git**.

| Role | Account | Scope |
|---|---|---|
| OPERATIONS_ADMIN | `ops.test@kekeride.ng` | global |
| PARK_SUPERVISOR | `supervisor.test@kekeride.ng` | AWK-PILOT only |
| PARK_DISPATCHER | `dispatcher.test@kekeride.ng` | AWK-PILOT only |

| Park | | |
|---|---|---|
| AWK-PILOT | active, 6.2109, 7.0740 | 4 km service radius, zones `STAGE-A` (staging) and `BOARD-A` (boarding) |
| AWK-OTHER | active, 6.35, 7.20 | **scoping control** — the dispatcher must never see it |

| Driver | Unit | Device | State |
|---|---|---|---|
| Sunday Okonkwo | T101 | **smartphone** | badged, waiting |
| Ifeoma Balogun | T102 | **feature phone** | badged, waiting |

Passenger: `test.passenger@kekeride.ng`.

No shift is opened by the script — starting one on the phone is part of the
test.

**Scoping verified over the LAN:**

```
parks visible : ['AWK-PILOT']
permissions   : 13 — no wallet / suspend / reveal_contact
GET /dispatcher/dashboard?parkId=<AWK-OTHER>  →  403
```

---

## 3. Results — automated and emulated

### 3.1 Emulated Android matrix

`scripts/android_touch_matrix.js` — Pixel 6a metrics, touch emulation, Android
user agent, real touch events, against `192.168.1.250:4100`.

| # | Scenario | Expected | Actual | Result |
|---|---|---|---|---|
| SETUP | Sign in and open a shift on an Android viewport | works | works | **PASS** |
| 3 | PWA runs on the Android viewport | SW active, secure context, touch | `{"sw":true,"secure":true,"touch":true,"width":393}` | **PASS** |
| B | Park request on the board with the waiting banner | banner up, badge correct | 7 queued, banner true | **PASS** |
| B2 | Queue badge and waiting timer | correct | badge `7`, timer `waiting 5m 55s` | **PASS** |
| **B3** | **Request arriving while the app is open alerts the device** | sound + vibration | **4 oscillators started, vibration `[160,90,160]`** | **PASS** |
| C1 | Tapping "Take this ride" claims it server-side | claimed | claimed | **PASS** |
| C2 | Tapping a driver opens the review sheet and assigns nobody | sheet, no assignment | sheet with driver, pickup, destination, passenger, fare, mode | **PASS** |
| F | The sheet states handoff mode and trip before committing | both shown | "Sent to their phone. Sunday has 18s to accept…" | **PASS** |
| G | Severed network never produces a false "Assigned" | no success claim | UI said nothing | **PASS** |
| G2 | Board reconciles after reconnect | authoritative state | queue reconciled, stale warning cleared | **PASS** |
| H | Repeated taps on Assign | at most one assignment | one | **PASS** |
| J | Closing a shift with work in hand | refused | 409 "You still have 6 requests in hand…" | **PASS** |
| L | Backgrounded PWA | documented | socket stays open; **fully closed cannot be woken** | **N/A — see §6** |

**12 passed, 0 failed, 1 not applicable.**

B3 is the one worth dwelling on. The first version of this check reported
"3 queued, banner up" and looked like a pass — but the queue had been populated
*before* the page loaded, and the app deliberately does not chime on first
render. It proved nothing about the case that matters. Rewritten to reset the
counters and then cause a genuine request to arrive over the socket, it now
records four oscillators and the exact `[160,90,160]` pattern the code
specifies. **That proves the alert fires. It does not prove it can be heard.**

### 3.2 Everything else

| Suite | Result |
|---|---|
| Jest (unit, integration, concurrency) | **563 passed**, 25 suites |
| TypeScript (`src` + `scripts`) | clean |
| Acceptance scenarios A–O against a live server | **17/17** |
| PWA audit | **19/19** |
| Real-click UI test | all pass, **zero CSP violations** |
| Launch verification script | **12/12** |
| Migration chain: virgin build | **PASS** |
| Migration chain: production-shaped upgrade | **PASS** |

---

## 4. Results — physical device test

**None of the following has been performed.** They require an Android phone, a
passenger handset, a driver handset and a person in a park.

| # | Scenario | Why it needs hardware | Result |
|---|---|---|---|
| A | Direct dispatch succeeds; request never enters Park Dispatch | needs a real driver accepting on a real device | **NOT RUN** |
| B | Alert is **audible** across the park at the tablet's volume | no automated check can hear | **NOT RUN — CRITICAL** |
| C | Smartphone driver receives and accepts the assignment | needs the driver app on a handset | **NOT RUN** |
| D | Smartphone driver declines / times out on a real device | same | **NOT RUN** |
| E | Feature-phone verbal handoff, spoken aloud | needs a person and a driver | **NOT RUN** |
| F | Selected driver is physically absent | needs physical absence | **NOT RUN** |
| G | Mobile data cut mid-assignment on the handset | emulated only | **NOT RUN** |
| H | Double tap with a real thumb | emulated only | **NOT RUN** |
| I | Passenger cancellation at four points | needs the passenger app | **NOT RUN** |
| J | Shift closure with unresolved work, on the phone | emulated only | **NOT RUN** |
| K | Suspension seen live on the dispatcher's phone | emulated only | **NOT RUN** |
| L | Behaviour when the PWA is fully closed | needs a real device and Doze | **NOT RUN — see §6** |
| — | Install from home screen; icon; standalone mode | Android install flow | **NOT RUN** |
| — | One-handed operation while holding a phone | ergonomics | **NOT RUN** |
| — | Overnight: battery optimiser vs the socket | needs hours on a device | **NOT RUN** |

Fill this table in during the test. `docs/launch_runbook.md` §6 is the same list
in checklist form.

---

## 5. Passenger experience (§5)

Checked against the passenger app source and the live API.

| Requirement | Finding | Result |
|---|---|---|
| Never shows raw Dio errors | `networkErrorMessage()` maps every transport failure to a human sentence and returns `null` when the server supplied its own | **PASS** |
| Never shows "Awka" as a hardcoded location | **DEFECT FOUND AND FIXED** — see below | **FIXED** |
| No QR code in the park flow | none anywhere in the passenger app | **PASS** |
| No driver PIN introduced by Park Dispatch | see the note below | **PASS, with a caveat** |
| Truthful "still searching" during the park phase | `ride:dispatch_round` re-arms the 150 s watchdog and renders "Still searching nearby…" | **PASS** |
| No assignment shown before server confirmation | the app only reports "Assigned" on an authoritative 200; a timeout surfaces with no status and is reported as outcome-unknown | **PASS** |
| False accepted state | not reachable: the ride is the single arbiter and only becomes `accepted` via the conditional UPDATE | **PASS** |

### The Awka defect

`booking_controller.dart` centred the map on `6.1264, 6.7876` with the comment
`// Awka fallback`. That point is **33 km west of Awka Main Park**. With no GPS
fix, the map — and therefore the default pickup pin — landed where no park has
coverage and no driver is near.

Fixed to `6.2109, 7.0740`. **This is in the passenger app, which is not part of
this deploy.** It ships with the next passenger release.

### The pickup-code caveat

Passengers on a park-assigned ride see "Tell your driver this code" with a
4-character code — because they see it on **every** ride. `pickupCode` is
generated at ride creation, before dispatch, and is pre-existing behaviour for
direct dispatch too.

Park Dispatch introduced no code, no QR and no extra confirmation, which is what
the constraint was about. But §5 as written says a passenger must never see PIN
instructions "for the normal park flow", and strictly read, they do. Removing it
for park rides only would make park rides *less* verifiable than direct ones.

**This is a product decision, not an engineering one.** Flagged, not changed.

---

## 6. Notifications when the app is not in front of the dispatcher

Honest statement of what happens, because this is the limitation most likely to
be quietly overstated:

| App state | Alert? |
|---|---|
| Open and in front of the dispatcher | **Yes** — sound, vibration, banner, tab badge. Verified (B3). |
| Installed, backgrounded, still running | **Yes, while the process is alive.** The socket stays open and `Notification` fires. Not verified on real hardware. |
| Fully closed, or killed by Android | **No. Nothing will wake it.** |

Web Push is not enabled. There is no mechanism by which a closed PWA can be
notified.

**Therefore the launch operating procedure must require the dispatcher device to
keep Park Dispatch open for the whole shift.** This is in
`docs/launch_runbook.md` §6 and must be stated in dispatcher training.

Still outstanding, and it is a real gap: **the shift UI does not warn a
dispatcher who is about to leave or close the app.** §9 of the launch brief
lists that warning as a condition for accepting this limitation. It is not
built. See §8.

---

## 7. Audit trail (§6)

Every action was exercised against the live API and the resulting rows read back
from `staff_audit_event`.

| Required | Recorded | Actor | Role | Park |
|---|---|---|---|---|
| Dispatcher login | `STAFF_LOGIN_SUCCEEDED` ×3 | StaffUser uuid | ✓ | n/a |
| Shift start | `SHIFT_OPEN` | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Request claimed | `PARK_JOB_CLAIMED` ×2 | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Driver selected / assigned | `PARK_JOB_ASSIGNED` | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Verbal handoff | recorded on the same row (`assignmentMode: verbal`) | | | ✓ |
| Queue slot released | `ROSTER_QUEUE_LEFT` | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Presence change | `PRESENCE_CHANGED` | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Escalation | `PARK_JOB_ESCALATED` | StaffUser uuid | PARK_DISPATCHER | ✓ |
| Contact reveal refused | `PERMISSION_DENIED`, outcome `denied` | StaffUser uuid | PARK_SUPERVISOR | — |
| Suspension | `park_dispatch.disabled` | StaffUser uuid | OPERATIONS_ADMIN | — |
| Reactivation | `park_dispatch.enabled` | StaffUser uuid | OPERATIONS_ADMIN | — |
| Shift close | `SHIFT_CLOSED` | StaffUser uuid | PARK_DISPATCHER | ✓ |

`rows=10 with_role=10 with_park=8 legacy=0` — every non-login row carries the
role, every park-scoped action carries the park, and none was performed by the
shared legacy key.

**Contact reveal itself was not recorded**, because it was correctly refused.
See §8: the endpoint it would have used could never have succeeded and has been
removed. The working route
(`POST /admin/live-requests/:rideId/reveal-contact`) is pre-existing and audited;
exercising it needs a SUPPORT_OFFICER or SUPER_ADMIN account and should be added
to the physical test.

---

## 8. Issues found and fixed during this phase

| # | Issue | Severity | Fix | Retest |
|---|---|---|---|---|
| 1 | `/dispatcher/requests/:jobId/reveal-contact` required an open shift **and** `monitor:reveal_contact`. No role holds both — every call would 403. Worse than dead: a dispatcher would reach for it in exactly the situation where it fails. | Medium | Endpoint removed; docs corrected to say the reveal is a support action via the existing admin route | 545 tests pass |
| 2 | Passenger map fallback 33 km from Awka, labelled "Awka fallback" | Medium (passenger app) | Corrected to 6.2109, 7.0740 | ships with the next passenger release |
| 3 | `dispatcher_operations.md` still described Phase 4's single-tap assign and the `/dispatcher` route | Low | Rewritten for the review sheet and `/dispatch` | — |
| 4 | The alert check proved only that the board had work, not that an arriving request alerts anyone | Medium (test defect) | Rewritten to reset counters and trigger a real arrival | B3 now passes on evidence |

Earlier phases' issues are in the commit log; the four above are what this
verification pass turned up.

---

## 9. GO / NO-GO

### **NO-GO for merge and deployment today.**

Not because anything failed. Because the gate has not been reached.

Every automated and emulated check passes — 545 tests, 17 acceptance scenarios,
12 emulated-Android scenarios, 19 PWA checks, both migration directions, a clean
secret scan and an engine diff that is byte-for-byte empty. The software is
ready in every sense that can be established from a machine.

But §9 of the launch brief makes GO conditional on the physical test, and the
physical test has not happened. I have no phone, no park and no ears. Declaring
GO on emulated evidence would be exactly the substitution this report exists to
prevent — and the single most likely thing to go wrong on Monday is a chime
nobody can hear over a Keke park, which is precisely what the emulation cannot
tell you.

Two things must happen before GO:

1. **Run §4 above** (or `launch_runbook.md` §6). Roughly 45 minutes with the
   devices. The critical row is B: *can the dispatcher hear it?*
2. **Build the leaving-the-app warning.** §9 permits the closed-PWA limitation
   only if "the shift UI warns the dispatcher before leaving or closing the
   app". That warning does not exist yet. It is small — a `beforeunload`
   handler plus a line in the shift screen — but the condition is explicit and
   currently unmet.

Everything else on the §9 list is satisfied:

- direct dispatch unchanged (empty diff against the engine files);
- smartphone assignment and verbal handoff both work;
- passenger states correct, one defect found and fixed;
- alerts fire while the app is open, on evidence;
- park scoping enforced and audited;
- runtime suspension works and the legacy key cannot operate it;
- migrations proven in both directions;
- automated tests green;
- no secrets, no unrelated changes.

---

## 10. What to do with this document

Fill in §4 during the physical test. Record what actually happened, including
anything that half-worked. If a critical row fails, the fix goes in as its own
commit with a regression test, and the row is retested — not relabelled.

When §4 is complete and every critical row passes, this report becomes the
evidence for GO, and `launch_runbook.md` §7–8 has the merge and deployment
steps.


---

## 11. Web Push — what must happen before the physical test

Two blockers, neither of which can be cleared from this repository.

### 11.1 Firebase Web App and VAPID key

Someone with Firebase console access must, in project `keke-ride-75ae8`:

1. **Add a Web App** — *Project settings → General → Your apps → Add app → Web*.
   Name it `KekeRide Park Dispatch`. Copy the config object.
2. **Generate a Web Push certificate** — *Project settings → Cloud Messaging →
   Web configuration → Generate key pair*. Copy the **public** key.
3. Set on the backend (all public identifiers; the service account is unchanged
   and stays server-only):

```
FIREBASE_WEB_API_KEY=…
FIREBASE_WEB_AUTH_DOMAIN=keke-ride-75ae8.firebaseapp.com
FIREBASE_WEB_PROJECT_ID=keke-ride-75ae8
FIREBASE_WEB_MESSAGING_SENDER_ID=889922883046
FIREBASE_WEB_APP_ID=1:889922883046:web:…
FIREBASE_VAPID_PUBLIC_KEY=…
```

Until these are set the app reports push as unavailable and says exactly which
values are missing — it does not fail silently. Verified:

```
GET /dispatcher/push/config
{"available":false,"missing":["FIREBASE_WEB_API_KEY", … 6 values],
 "message":"Push is not configured on this server. Alerts will only work while the app is open."}
```

### 11.2 An HTTPS test URL

**The final acceptance test must not use Chrome's
`unsafely-treat-insecure-origin-as-secure` flag.** A PWA behaves differently
under it, and a test that passes only with a flag has proved nothing about the
real thing.

`staging.kekeride.ng` already exists, resolves to the droplet (206.189.96.147)
and serves HTTPS — it currently returns 401 because it sits behind nginx basic
auth. That is the intended test URL:

**`https://staging.kekeride.ng/dispatch/`**

Deploying this branch to staging is the one remaining action, and it has not
been taken because it touches shared infrastructure. The commands are in
`launch_runbook.md` §3b with `api_staging` in place of `api_prod`.

Note for the tester: the basic-auth prompt appears once per browser. The service
worker's own fetches carry the credentials afterwards, but if push behaves oddly
under basic auth, removing the htpasswd line for `staging.kekeride.ng` during the
test window is the cleaner path.

---

## 12. Web Push test matrix — for the human tester

Fill this in on the real phone. Nothing here has been performed.

**Device details**

| | |
|---|---|
| Device model | |
| Android version | |
| Browser + version | |
| Network (Wi-Fi / MTN / Airtel / Glo) | |
| Installed as PWA? | |
| Date / tester | |

**The tests**

| # | Step | Expected | Actual | P/F |
|---|---|---|---|---|
| 1 | Open `https://staging.kekeride.ng/dispatch/` | Loads over HTTPS, no flag needed | | |
| 2 | Install to home screen | Prompt offered; KekeRide diamond icon | | |
| 3 | Open from the home screen | Standalone, no address bar | | |
| 4 | Sign in as the park dispatcher | Works | | |
| 5 | Shift screen → **Set up** background alerts | Permission prompt; then "On" | | |
| 6 | **Send test** | Notification arrives within seconds | | |
| 7 | Is it **audible** at the phone's normal volume? | Yes | | |
| 8 | Does it **vibrate**? | Yes | | |
| 9 | Open a shift | Starts; no silent-shift warning | | |
| 10 | **Lock the screen.** Generate a real park request | Notification on the lock screen | | |
| 11 | Audible with the screen locked? | Yes | | |
| 12 | **Fully close the PWA** (swipe from recents). Generate another | Notification still arrives | | |
| 13 | …and after the phone has sat idle 10+ minutes? | Arrives, possibly delayed | | |
| 14 | Tap the notification | Opens Park Dispatch **on that request** | | |
| 15 | Is the request state current, not the notification's? | Board shows authoritative state | | |
| 16 | Assign a smartphone driver from the opened request | Works | | |
| 17 | Repeat with a feature-phone **verbal handoff** | Works | | |
| 18 | Leave a request unanswered ~15 s | **One** reminder, not a stream | | |
| 19 | Let it run to expiry | Final call, then **silence** | | |
| 20 | Claim a request immediately | **No** reminder afterwards | | |
| 21 | Restart the app; generate a request | Still alerts | | |
| 22 | **Restart the phone**; open the app once; lock it; generate a request | Still alerts | | |
| 23 | Switch Wi-Fi off, use mobile data; repeat | Still alerts | | |
| 24 | Sign out, sign in again | Token re-registers; alerts resume | | |
| 25 | Uninstall, reinstall, sign in | New token; alerts resume; no duplicates | | |
| 26 | Two dispatchers at the same park | Both alerted; one claim silences both | | |
| 27 | End the shift; generate a request | **No** alert — the device is unbound | | |

**Critical rows: 7, 10, 11, 12, 14.** If a dispatcher cannot be alerted with the
screen locked, or the notification does not open the right request, this is a
NO-GO regardless of everything else.

### What to expect on a non-stock Android

Row 12 and 13 are the ones most likely to fail, and it will not be a bug in this
code. Xiaomi/MIUI, Huawei/EMUI, Oppo/ColorOS and aggressive Samsung battery
settings kill Chrome's background process, and a killed browser receives
nothing. If they fail:

1. Record the exact device and Android skin.
2. Add Chrome to the device's protected/auto-start apps and disable battery
   optimisation for it, then retest.
3. If it still fails, that phone model is unsuitable as a dispatcher device and
   the operating procedure must keep the app open on it.

This is documented honestly in `dispatcher_web_push_audit.md` §4. The web cannot
override an OEM battery manager, and no amount of code will change that.
