# Pickup Code — Audit and Decision

Asked for by §7 of the Phase 6 brief, after the Phase 5 report noted that
passengers on Park Dispatch rides still see "Tell your driver this code".

**Conclusion: the pickup code is displayed text, not a security control. Nothing
anywhere validates it.** The presentation has been corrected to say so. The code
itself is kept.

---

## 1. The questions, answered

| Question | Answer | Evidence |
|---|---|---|
| Is the code validated by the backend? | **No.** | `pickupCode` appears in `socket_handler.ts` only where it is *generated* (line 575) and *echoed* to clients (2036, 2064, 2155, 2231). There is no comparison, no equality check, no validation branch anywhere in `src/`. |
| Does the driver app require it? | **No.** | `trip_operation_hud.dart` renders `_buildPickupCodeCard(code)` — a read-only `Text`. There is no `TextField`, no input, no submission. |
| Is it required to start a direct-dispatch ride? | **No.** | `ride:start` is gated on a **geofence**: the driver must be within range of the pickup (`TOO_FAR_FROM_PICKUP`). The code is not consulted. |
| Is it required for a Park Dispatch smartphone driver? | **No.** | Same `ride:start` path. Park rides are ordinary rides after assignment. |
| Is it usable by a feature-phone driver? | **No.** | A feature-phone driver has no app and no screen. There is nothing to compare against. |
| What happens if the passenger does not provide it? | **Nothing.** | No code path observes it. The ride proceeds identically. |
| Is it a security control or displayed text? | **Displayed text.** | It is a social cross-check: both parties can see the same four characters and compare them by voice. That has genuine value between two humans. It is not enforced by any system, and calling it a control would be false. |

---

## 2. Why it was worth checking rather than deleting

It would have been easy to read "passengers see a PIN instruction" and remove
it. That would have been wrong twice over:

1. **It is generated for every ride, not by Park Dispatch.** `pickupCode` is
   created at ride creation, before dispatch runs. Park rides show it because
   *all* rides show it. Park Dispatch introduced no code, no QR and no extra
   confirmation — which is what the original constraint was actually about.
2. **The cross-check is genuinely useful, especially for park rides.** A park
   passenger gets a driver they did not choose, arriving from a park they may
   not know about. Two people comparing the same four characters is a cheap,
   offline, device-free way to confirm they have found each other.

Removing it would have taken away something helpful in order to satisfy a
literal reading of a rule about not *introducing* one.

---

## 3. What changed

Only the words. Both apps described the code imperatively, which told people to
do something that has no effect if they do not.

| | Before | After |
|---|---|---|
| Passenger | "Tell your driver this code" | "Ride code — you can check it matches your driver's screen" |
| Driver | "Ride code — ask your passenger" | "Ride code — your passenger sees the same code" |

The passenger's **plate card is already the dominant identifier** on the arrival
screen, and it remains the real check — it works whether or not the driver has a
phone, which the code does not.

### The feature-phone path

For a verbally assigned feature-phone driver there is **no screen to compare
against**, so the code cannot function even as a cross-check. What the passenger
has instead, and what they should use:

- the **vehicle plate**, shown prominently;
- the driver's **name and photo**, delivered with the assignment;
- the **Keke unit number**.

All three come from the assignment record, all three are visible without the
driver holding anything, and all three are evidence the dispatcher recorded when
they made the assignment. That is the safe, evidence-based alternative §7 asks
for — and critically, **it does not give the dispatcher any new power to advance
the ride**: they assign, and the existing lifecycle takes over.

---

## 4. What was deliberately not done

- **No new mandatory step for passengers.** No QR, no PIN entry, no extra
  confirmation. The product decision stands.
- **The code was not removed.** It costs nothing, it is already generated, and
  two humans comparing four characters is a reasonable thing to offer.
- **No server-side enforcement was added.** Making the code mandatory would
  break every feature-phone park ride by design, and would strand any passenger
  whose phone died between booking and pickup. The geofence is the control that
  actually protects ride start, and it already exists.

---

## 5. Tests

The behaviour under test is a *negative*: the code must not become a gate.

- `ride:start` geofence enforcement is covered by the existing ride-integrity
  tests; those assert that proximity is what permits a start.
- No test asserts a pickup-code comparison, because there is none to assert —
  adding one would be inventing a control that does not exist.
- The park assignment tests confirm that a verbally assigned ride reaches
  `accepted` and proceeds through the ordinary lifecycle with no code step.

Both app changes are copy-only and ship with their respective app releases, not
with the backend deploy.
