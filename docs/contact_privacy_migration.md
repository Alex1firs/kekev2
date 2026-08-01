# Passenger Contact Privacy Migration

Retiring `passengerPhone` from the dispatch offer payload without breaking the call button on driver
phones already in the field.

Related: [`park_dispatch_mode_architecture.md`](./park_dispatch_mode_architecture.md) §7 ·
[`staff_identity_architecture.md`](./staff_identity_architecture.md)

---

## 1. The defect

`buildOfferPayload` (`socket_handler.ts`) put the passenger's full dialable number into the ride offer
sent to **every candidate driver** — everyone the ride rang, whether or not they accepted, and
including drivers who declined or never answered. A single ride at the widest radius could hand one
passenger's number to ten different people.

## 2. Why it could not simply be deleted

The driver app builds its `TripRequest` from the **offer** payload (`driver_controller.dart:440`) and
reads the phone from there for the in-ride call action (`trip_operation_hud.dart:516,585`).

Nothing else supplies it:
- `ride:confirmed` carries only `{ rideId }` (`socket_handler.ts:789`);
- `GET /rides/active/driver` returned the raw `Ride` row with no contact data at all.

Which is also why **a driver whose app restarted mid-ride already lost the call button** — a
pre-existing bug, and the same gap that blocks the privacy fix. Deleting the field in one release would
have silently removed the ability to phone a passenger from every driver in the fleet.

## 3. What Phase 1 built

**Nothing observable changed.** The default mode is `legacy`, byte-identical to the previous behaviour
— verified by a test asserting the exact payload shape. What exists now is the machinery to move.

| Piece | Location |
|---|---|
| Mode configuration + version comparison | `src/config/contact_privacy_config.ts` |
| `ContactAccessService` — masked / assigned-driver / staff reveal | `src/services/contact_access_service.ts` |
| `ContactRevealEvent` — who saw what, until when | `src/models/ContactRevealEvent.ts` |
| Assignment-time endpoint `GET /rides/:rideId/contact` | `src/routes/ride_routes.ts` |
| Contact on active-ride recovery | `src/routes/ride_routes.ts` (`/active/driver`) |
| Staff reveal `POST /admin/rides/:rideId/passenger-contact` | `src/routes/staff_admin_routes.ts` |
| Per-driver offer shaping | `socket_handler.ts` (`offerContactFor`) |
| `device_token.appVersion` | migration `1788000000000` |

### Three access paths, three rules

| Path | Who | Rule |
|---|---|---|
| **Masked** | anyone entitled to see the ride | `0801••••678` — recognisable on a call, useless for contacting someone |
| **Assigned driver** | the driver holding the ride | real number, automatic, for the ride + 2 h grace. Not a decision; it is the job |
| **Staff reveal** | `ride:reveal_contact` / `dispatch:reveal_passenger_contact` | reason mandatory, 30-minute window, audited **critically** |

Nothing returns a contact detail without first writing a `ContactRevealEvent`. The staff path writes
its audit row *before* returning the number, and a failed audit write aborts the reveal.

### A cache-correctness fix that came with it

`buildOfferPayload` used to produce one payload per offer, cached in `dispatchPayloads` for reconnect
recovery. Contact is now **per driver** (it depends on that driver's app version), so the cached
payload is contact-free and contact fields are merged at each emit — including on the reconnect path,
which re-derives them for the reconnecting driver. Without this, a cached payload could deliver one
driver's contact variant to a different driver.

`offerContactFor` **fails closed**: an error while shaping contact withholds a number, it never leaks one.

## 4. The four modes

`CONTACT_PRIVACY_MODE`:

| Mode | Old app (unknown / below min) | New app (≥ min version) |
|---|---|---|
| `legacy` *(default)* | full number | full number |
| `masked_versioned` | full number | masked only |
| `strict_versioned` | full number | **no contact** |
| `strict` | **no contact** | **no contact** |

"New enough" is decided per driver from `device_token.appVersion`, the version their device last
registered with. **An app that has never reported a version is treated as OLD** — which is every
install shipped so far. That default is the safety property: tightening the mode cannot break a client
that has not told us what it is.

## 5. The release sequence

```
  RELEASE 1 — backend, purely additive        [ SHIPPED IN THIS PHASE ]
     GET /rides/:rideId/contact           (assigned driver only, audited)
     GET /rides/active/driver             now returns passengerContact
     device_token.appVersion              accepted by POST /notifications/tokens
     CONTACT_PRIVACY_MODE=legacy          nothing changes for anyone
     → also fixes the existing "call button lost on app restart" bug

  RELEASE 2 — driver app
     • send appVersion when registering the FCM token
     • read contact from ride:confirmed / GET /rides/:rideId/contact
       and from active-ride recovery; merge into activeRequest
     • stop depending on passengerPhone in the offer payload
     → the app now works whether or not the offer carries a phone

  ── WAIT FOR ADOPTION ──
     Monitor: SELECT count(*) FROM device_token
               WHERE role='driver' AND "isActive" AND "appVersion" IS NULL;
     Proceed when ≥95% of active driver devices report a version at or above the target.

  RELEASE 3 — flip the mode, no deploy
     CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION=<the Release 2 version>
     CONTACT_PRIVACY_MODE=strict_versioned
     → new apps stop receiving passenger contact in offers; old apps unaffected

  RELEASE 4 — finish
     CONTACT_PRIVACY_MODE=strict
     then delete the deprecated branch from ContactAccessService.offerContactFields
```

Rollback at any point is one environment variable back to `legacy`.

## 6. Deprecation markers

Both are annotated `@deprecated` in source with a pointer to this document:

- `ContactAccessService.offerContactFields` — the whole offer-time contact concept;
- `SocketHandler.offerContactFor` — its call site in the dispatch path.

The wire field `passengerPhone` keeps its name in the modes that still send it, because that is the key
installed apps read. It is removed by sending `null`, not by renaming.

## 7. What Park Dispatch may never do

From `park_dispatch_mode_architecture.md` §7, encoded in the permission matrix:

- a **park pre-alert** carries area-level geography, fare and payment mode — **no passenger identity**;
- a **dispatcher** holds `dispatch:view_passenger_masked_contact` and *not* the reveal permission;
- **park roster members** never receive passenger contact under any circumstance;
- a reveal is time-boxed, and re-reading after expiry produces a **new** event — so a long incident
  appears as repeated deliberate access rather than one look.

## 8. Deliberately deferred

**A masked-number call relay** (Africa's Talking / Twilio) is the right end state: neither party ever
sees the other's real number. It needs a telephony vendor, a number pool and per-minute cost, so it is
a post-pilot item. v1 is controlled, audited, expiring reveal — a real improvement, and not the whole
answer. Stated rather than hidden.

## 9. Verification

| Property | Test |
|---|---|
| Default mode is byte-identical to previous behaviour | `the DEFAULT mode is byte-identical to the previous behaviour` |
| Unreported version keeps the legacy payload | `24 — an app that has never reported a version keeps the legacy payload` |
| Below-minimum version keeps the legacy payload | `an app below the minimum version keeps the legacy payload` |
| At/above minimum receives no contact | `25 — an app at or above the minimum receives NO contact in the offer` |
| Masked mode gives no dialable number | `masked_versioned gives a new app a masked number and no dialable one` |
| Only the assigned driver may fetch contact | `22 — a driver who is NOT assigned is refused` |
| Every access writes a reveal event | `20 — every driver access writes a ContactRevealEvent` |
| Staff reveal needs a reason and is audited | `19, 20 — a staff reveal demands a reason and is audited critically` |
| Version comparison is numeric, not lexical | `compares versions numerically, not lexically` |
| Reveal records field names, never values | asserted inside the reveal-event test |
