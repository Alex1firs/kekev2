# Two-phone test procedure — delayed-ride coordination

One passenger phone, one driver phone, against a backend you control. Every step
below produces a visible outcome on **both** handsets; if one side shows nothing,
that is the failure, not a timing quirk.

## Why this needs real phones

Three of the guarantees cannot be checked in a simulator or a test:

- **Push while the app is closed.** The decisive case for the whole feature is a
  party whose app is not running. Only a real device with FCM registered proves it.
- **Screen-lock delivery and tap-through.** The prompt has to arrive on a locked
  screen and open the right ride.
- **Doze / battery optimisation.** An Android phone that has decided your app is
  idle will silently swallow a socket. The driver app has a foreground service for
  this; a real handset is the only way to see it working.

## Setup

Point both apps at your backend and make the timings short enough to observe.
`STALE_*` values are minutes, so production defaults would make this a half-day
exercise.

```bash
# On the backend, for the duration of the test only.
STALE_SWEEP_ENABLED=true
STALE_SWEEP_INTERVAL_MS=15000        # sweep every 15s instead of every few minutes
STALE_ACCEPTED_MIN_MINUTES=2         # "running late" after 2 min
STALE_ACCEPTED_MAX_MINUTES=4         # prompt both parties after 4 min
STALE_ARRIVED_CANCEL_MINUTES=4
STALE_DECISION_WINDOW_MINUTES=2      # 2 min to answer
STALE_REMINDER_INTERVAL_MINUTES=2    # check-ins every 2 min
STALE_PARTY_OFFLINE_MINUTES=2        # "gone dark" after 2 min
STALE_ESCALATE_AFTER_OFFLINE_MINUTES=3
STALE_MUTUAL_ABANDONMENT_MINUTES=6
STALE_SWEEP_DRY_RUN=false            # ← this test needs real writes
```

Install:

```bash
adb -s <PASSENGER_SERIAL> install -r apps/keke_passenger/build/app/outputs/flutter-apk/app-release.apk
adb -s <DRIVER_SERIAL>    install -r apps/keke_driver/build/app/outputs/flutter-apk/app-release.apk
```

Watch the coordination decisions as they happen:

```bash
# Backend — one line per decision, with the reasoning attached.
docker compose logs -f backend | grep -E 'stale_sweep|decision_requested|escalated_to_support|refused_silent_cancel'

# Each app.
adb -s <PASSENGER_SERIAL> logcat -s flutter | grep -E 'PASSENGER_SYNC|ANALYTICS.*coordination'
adb -s <DRIVER_SERIAL>    logcat -s flutter | grep -E 'DRIVER_SIGNAL|ANALYTICS.*coordination'
```

Grant notification permission on both phones before starting, and on the driver
phone accept the battery-optimisation prompt. Skipping either invalidates
scenarios 8 and 9.

---

## Scenario 1 — soft reminder (nobody is asked anything yet)

1. Book a ride; accept it on the driver phone.
2. **Do not move the driver phone.** Wait ~2 min.

| Passenger | Driver |
|---|---|
| "Your driver is taking longer than expected" on a cream card | "Are you still heading to the passenger?" with **I'm still coming** |

No countdown yet, and nothing has been asked — this rung of the ladder only informs.

**Fails if:** either side shows a red banner, the word "stale"/"timeout" appears, or
the driver's notification threatens cancellation.

## Scenario 2 — both parties asked, driver answers

1. Continue from scenario 1. Wait until ~4 min after acceptance.
2. Both phones now show a countdown ("2 minutes left to respond").
3. Tap **I'm still coming** on the driver phone.

| Passenger | Driver |
|---|---|
| Card goes calm: "Your driver confirmed they are still coming" | "Passenger notified that you are still coming" |

**Fails if:** the driver is marked arrived (check the passenger's journey bar — it
must still say *on the way*), or the passenger sees nothing.

## Scenario 3 — a long delay does not become a cancellation

1. From scenario 2, simply wait. Ten minutes, twenty, longer.
2. Keep both apps open.

**Expected:** periodic calm check-ins on both phones. **The ride is never
cancelled.** This is the core product claim — time alone triggers communication,
never termination.

**Fails if:** the ride is cancelled at any point while both apps are open and
responsive.

## Scenario 4 — passenger asks to cancel; driver accepts

1. On the passenger phone tap **Cancel ride** → confirm in the dialog.
2. Passenger shows "Waiting for a response to your cancellation" — **the ride is
   still active**.
3. Driver phone shows "Passenger requested to cancel this ride".
4. Tap **Accept cancellation** → confirm.

| Passenger | Driver |
|---|---|
| Ride ends; can book again | Ride ends; can accept new rides |

**Fails if:** the passenger's ride ends at step 1 (that would be a unilateral
cancellation), or the driver is never asked.

## Scenario 5 — driver declines the cancellation

Repeat scenario 4, but tap **I'm still coming** on the driver phone at step 4.

**Expected:** the ride continues. The passenger sees "Your driver is continuing".

## Scenario 6 — driver asks to cancel; passenger answers

1. Driver taps **Cancel ride** → confirm.
2. Passenger sees "Your driver requested to cancel this ride" with **Accept
   cancellation** and **Continue waiting**.
3. Try each on separate runs.

**Fails if:** the driver's ride ends before the passenger answers.

## Scenario 7 — a cancellation request nobody answers

1. Driver taps **Cancel ride** → confirm.
2. Put the **passenger** phone in aeroplane mode and leave it for the decision
   window (2 min here).

**Expected:** the backend cancels with `CANCELLED_REQUEST_UNANSWERED`. When the
passenger comes back online they see the exact outcome — "The cancellation went
ahead because there was no answer" — not a generic error.

Confirm in the log: `cancellationReason` on the ride row is
`CANCELLED_REQUEST_UNANSWERED`, and `refused_silent_cancel` does **not** appear.

## Scenario 8 — driver goes dark → support, not cancellation

1. Get to an accepted ride.
2. **Force-stop the driver app** (`adb shell am force-stop ng.kekeride.driver`) and
   put that phone in aeroplane mode.
3. Keep the passenger app open. Wait past the escalation threshold (~3 min).

**Expected on the passenger phone:** "We haven't been able to reach your driver"
with **Find another Keke** and **Contact support**.

**Expected on the backend:** `escalated_to_support`, `autoCancelled: false`, and the
ride appears in the admin monitor as requiring review.

**Fails if:** the ride is cancelled. Escalation is explicitly not cancellation —
once a human owns the ride, the sweeper stops acting on it. Verify by waiting
another ten minutes: still not cancelled.

## Scenario 9 — push while the app is closed, and tap-through

1. Get to an accepted ride, then **close the driver app entirely** (swipe it away —
   do not force-stop, so FCM still delivers) and lock the screen.
2. Wait for the decision prompt.

**Expected:** a lock-screen notification — "Still going to this pickup?" — and
tapping it opens the app **on that ride**, showing the prompt with the countdown
**resumed where it actually is**, not restarted at 2:00.

**Then check the dedupe:** exactly **one** prompt appears, not one from the push and
another from the socket. In logcat you should see one
`coordination_notification_displayed` and no second `coordination_prompt_displayed`
for the same `eventId`.

**Also confirm:** the notification text contains no pickup or destination address.

## Scenario 10 — app killed mid-conversation

1. Reach an open decision prompt on the passenger phone.
2. Force-stop the app: `adb shell am force-stop ng.kekeride.passenger`.
3. Reopen it.

**Expected:** the prompt is back, with the countdown at the correct remaining time.

4. Now answer it, force-stop again, reopen.

**Expected:** the prompt does **not** come back. An answered question is not
re-asked.

## Scenario 11 — network loss mid-answer

1. Reach an open prompt.
2. Put the phone in aeroplane mode, then tap **Continue waiting**.

**Expected:** the button shows "Sending your response…", the ride stays active, and
nothing is assumed to have worked. Restore the network — the app re-reads the
authoritative state.

## Scenario 12 — arrival ends the conversation

1. Reach a delayed-driver prompt.
2. Tap **Arrived** on the driver phone.

**Expected:** the coordination card disappears on **both** phones immediately.
Being there is the answer to "are you coming?".

## Scenario 13 — a trip under way is never in this flow

1. Start the trip.
2. Leave it running well past the in-progress threshold.

**Expected:** no coordination card, no prompt, no countdown on either phone. The
backend flags it for a human (visible in the admin monitor) and **never** cancels
it — a real trip happened and a real fare is owed.

**Fails if:** any decision prompt appears during a started trip.

## Scenario 14 — both parties dark

1. Reach an accepted ride.
2. Put **both** phones in aeroplane mode and close both apps.
3. Wait past `STALE_MUTUAL_ABANDONMENT_MINUTES` (6 min here).
4. Bring both back online.

| Passenger | Driver |
|---|---|
| "This ride was closed because we couldn't reach either you or the driver." + **Find another Keke** | "This ride was closed after neither party responded." + **Go back online** |

Check the history on both apps: the ride is present with the system reason, and
neither message blames anyone.

## Scenario 15 — accessibility

With TalkBack on (Android Settings → Accessibility → TalkBack), reach a prompt on
either phone.

**Expected:** swiping to the card announces the situation, the detail **and the
remaining time in words** as one utterance — e.g. *"Are you still heading to the
passenger? The passenger is waiting… 2 minutes left to respond."*

**Also:** the cancel button must not be the first control focus lands on, and each
button announces its own label.

Then set Display size and Font size to their largest values and confirm no text is
clipped and no button falls off the card.

---

## Afterwards

Restore the production `STALE_*` values and redeploy. Leaving the test thresholds
live would prompt real passengers after two minutes of ordinary Onitsha traffic.

Then confirm the invariant held for the whole session:

```bash
# Any cancellation that happened WITHOUT both parties being asked would appear here.
docker compose logs backend | grep refused_silent_cancel
```

An empty result is what you want — and if a line does appear, it means the guard
caught an attempt rather than that one slipped through.
