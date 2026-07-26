# Ride coordination contract (backend ⇄ apps)

Audit of what the backend on `feat/stale-ride-recovery` actually emits and accepts,
followed by the gaps that had to be closed before the apps could render it.

Everything here was read out of the source, not assumed. Where a field the apps
need did not exist, it is listed under **Gaps closed** rather than silently
inferred client-side.

## 1. Events the backend already emitted

| Event | Room | Fields as found |
|---|---|---|
| `ride:stale_decision_required` | ride + driver | `rideId`, `reason`, `respondBySeconds`, `respondByAt`, `waitingFor`, `options[]`, `role`, `title`, `body` |
| `ride:delay_update` (reminder) | ride + driver | `rideId`, `delayState`, `role`, `title`, `body`, `actions[]` |
| `ride:delay_escalated` | ride **or** driver (engaged party only) | `rideId`, `delayState`, `title`, `body`, `actions[]`, `supportNotified` |
| `ride:cancel_requested` | the *other* party | `rideId`, `requestedBy`, `respondWithinMinutes`, `actions[]`, `title`, `body` |
| `ride:cancel_declined` | ride + driver | `rideId`, `declinedBy`, `title`, `body` |
| `ride:stale_decision_resolved` | ride + driver | `rideId`, `decidedBy`, `choice`, `extendedUntil`, `minutes`, `message` |
| `ride:activity_seen` | ride + driver | `rideId`, `by`, `type` |
| `ride:extension_granted` | acting socket only | `rideId`, `extendedUntil`, `minutes` |
| `ride:cancelled` | ride + driver | `rideId`, `reason`, `systemCancelled` |
| `ride:cancel_request_ack` | acting socket | `rideId`, `accepted`, `reason?`, `awaiting?` |
| `ride:cancel_response_ack` | acting socket | `rideId`, `decision`, `applied` |
| `ride:stale_decision_ack` | acting socket | `rideId`, `accepted`, `choice?`, `reason?`, `decidedBy?`, `decidedChoice?` |
| `ride:error` | acting socket | `code`, `message` |

Push notification `data.type` values: `STALE_RIDE_WARNING`, `STALE_RIDE_DECISION`,
`CANCELLATION_REQUESTED`, `RIDE_ESCALATED`, `RIDE_CANCELLED`.

## 2. Events the backend accepts

| Event | Payload | Server rules |
|---|---|---|
| `ride:activity` | `{rideId, userId, role, type}` | `type` ∈ the `RideActivityType` allow-list. Recorded as INTENT, so it extends the window. Silently ignored if the ride isn't yours. |
| `ride:cancel_request` | `{rideId, userId, role}` | Only `accepted`/`arrived`. Conditional UPDATE rejects a second concurrent request (`request_already_pending`). |
| `ride:cancel_response` | `{rideId, userId, role, decision: accept\|continue}` | Requires `cancellationRequestState === 'pending'`; the requester may not answer their own request. |
| `ride:stale_decision` | `{rideId, userId, role, choice: wait\|cancel}` | Requires `staleDecisionPromptedAt != null`. First answer wins via `staleDecisionChoice IS NULL`. `wait` is capped by `maxExtensions`. |
| `ride:still_coming` | `{rideId, driverId}` | Driver-only; capped by `maxExtensions`. |

## 3. Field-by-field verification against the requested list

| Required | Where it comes from | Status before this change |
|---|---|---|
| ride ID | every payload | present |
| current ride status | — | **absent from every coordination event** |
| delayed party | `waitingFor` on the prompt; implied elsewhere | partial |
| stale reason | `reason` (engineering code, e.g. `driver_never_arrived`) | present but not displayable |
| decision deadline | `respondByAt` on the prompt only | **absent from `ride:cancel_requested`** |
| remaining response time | `respondBySeconds` | present on prompt only |
| requesting party | `requestedBy` / `declinedBy` / `decidedBy` | present |
| permitted actions | `actions[]` / `options[]` | present on some events, absent on the prompt-adjacent ones |
| extension count | — | **absent** (app could not know "keep waiting" would be refused) |
| support escalation status | `supportNotified` on the escalation event only | **not recoverable after restart** |
| cancellation reason | `reason` on `ride:cancelled` — a raw code | present but not displayable |
| idempotency identifiers | — | **absent everywhere** |

## 4. Gaps closed (minimum compatible additions)

1. **`eventId` on every coordination event.** Deterministic, derived from
   `(rideId, kind, round//sequence)` — not random — so a socket event and the push
   notification that accompanies it collapse to one prompt in the UI, and a
   reconnect that replays an event cannot double-prompt. `§9` requires exactly this.

2. **`respondByAt` (absolute ISO) on `ride:cancel_requested`.** It carried only
   `respondWithinMinutes`, so an app restarting mid-window would have restarted the
   countdown from full — the opposite of `§8`'s "restore countdown from server
   timestamps".

3. **A socket emit for the soft-reminder/warning stage.** `sendWarning()` sent push
   only. An app in the foreground with a healthy socket saw nothing at all, which
   made Stage 1 of the product spec invisible.

4. **Human copy and a stable `outcome` on `ride:cancelled`.** It carried
   `reason: 'SYSTEM_ABANDONED_BY_BOTH'`. `§10` forbids showing engineering codes, and
   the apps must not maintain their own translation table that drifts from the
   server's. The passenger/driver message the cleanup service already composes for
   push is now on the socket payload too.

5. **`GET /api/v1/rides/:rideId/coordination`** and a `coordination` block on
   `/rides/active/passenger` and `/rides/active/driver`. This is the authoritative
   recovery read for `§8`: one round trip returns the stage, the server deadline,
   the permitted actions, whether the decision is already resolved, and the
   escalation flag. Without it the app would have to re-derive policy from raw
   columns, which `§5` explicitly forbids ("make the backend authoritative").

6. **`rideStatus` and `extensionsRemaining` on the decision prompt.** The app has to
   know whether offering "Keep waiting" is honest before it draws the button.

7. **`actions[]` on the decision prompt, per role.** It carried only
   `options: ['wait','cancel']` — what the *server accepts*. That is not enough to
   draw a button: "wait" means **"I'm still coming"** to a driver who has not
   arrived and **"Keep waiting"** to one already parked at the pickup point, and
   only the server knows which situation the ride is in. Both fields are now sent,
   so an older build still works off `options`.

8. **The warning push no longer threatens cancellation.** It read *"This ride will
   be cancelled in about N minutes if you are no longer on your way"* — which the
   coordination model made false. Nothing is cancelled on a timer any more, and a
   notification that lies is also one drivers learn to distrust.

9. **`cancellationReason` recorded on the passenger's own cancel path.** It wrote
   only `status = canceled`, so history could not distinguish a passenger changing
   their mind from a coordination outcome (§6 requires the correct system reason in
   history).

## 5. Integration defects found in the apps

1. **The passenger app reported every `ride:cancelled` as `passengerCancelled`** —
   including a driver-initiated cancellation and a system close. The passenger was
   told "You cancelled this ride" when they had not. Fixed by reading the
   backend `outcome`.

2. **Neither app listened for any coordination event.** All nine were dropped on the
   floor by the `switch` in `_listenToSocket`.

## 6. Stage → UI mapping

| Backend `delayState` / event | App stage | Passenger sees | Driver sees |
|---|---|---|---|
| `staleWarnedAt` set, `accepted` | `driverRunningLate` | "Your driver is taking longer than expected" | "Are you still heading to the passenger?" |
| `awaiting_confirmation` + prompt unresolved | `awaitingDecision` | "Waiting for your driver to confirm." | prompt with "I'm still coming" / "Cancel ride" |
| `delayed_driver_confirmed_en_route` | `driverConfirmedEnRoute` | "Your driver confirmed they are still coming." | calm "Passenger notified that you are still coming." |
| `driver_offline` + `escalatedToSupportAt` | `driverUnreachable` | "We haven't been able to reach your driver." + Find another Keke | — |
| `waiting_for_passenger` | `waitingForPassenger` | "Your driver is waiting" + "I'm coming" | "Passenger is taking longer to come out" |
| `passenger_offline` + escalated | `passengerUnreachable` | — | "This ride needs support assistance." |
| `cancellation_requested` | `cancellationRequestedByOther` / `ByMe` | "Your driver requested to cancel this ride." | "Passenger requested to cancel this ride." |
| `escalated_to_support` | `escalatedToSupport` | "This ride needs support assistance." | same |
| `ride:cancelled` w/ `SYSTEM_ABANDONED_BY_BOTH` | `closedNoResponse` | "This ride was closed because we couldn't reach either you or the driver." | "This ride was closed after neither party responded." |
