# Extending the Communications Centre

How to add a new audience, a new channel or a new message type without
redesigning anything. Written while only passengers exist, so the seams are
declared rather than discovered.

---

## The three axes

Everything the Centre does is a point in three dimensions:

| Axis | Today | Where it is decided |
|---|---|---|
| **Audience** — who is addressed | passenger | `AudienceService`, `AudienceType` |
| **Channel** — how it reaches them | email, push, in-app, SMS | `CommunicationCampaignChannel`, `communications_config` |
| **Priority** — what it is worth | P1 / P2 / P3 | `notification_priority.ts` |

A new requirement is almost always a new value on one axis, not a new system.

---

## Adding an audience

`AudienceType` already names the six audiences KekeRide is likely to want:
passenger, driver, dispatcher, supervisor, staff, partner. Only `passenger` is
in `REGISTERED_AUDIENCES`; the rest throw a clear error at resolution time.

That refusal is the design. A driver has no consent record, so falling back to
"send it to passengers instead" or "send it anyway" are both wrong. Adding one
means, in order:

1. **A consent record.** `PassengerCommunicationPreference` is passenger-keyed
   by name and by foreign key. A driver equivalent is a second table with the
   same columns, not a nullable column added to the first — the two have
   different lawful bases and different retention.
2. **An opt-in surface.** Someone must be asked. The passenger prompt
   (`communication_opt_in_prompt.dart`) is the pattern: shown at rest, never
   mid-flow, capped at two showings, and *no* pre-ticked box.
3. **A query branch** in `AudienceService.resolve()`, beside the passenger one.
4. **Registration** — add the type to `REGISTERED_AUDIENCES`. Deliberately the
   last step, so the switch cannot be flipped before the consent exists.

The unit test in `emergency_controls.test.ts` asserts the registry contains only
`passenger`. It will fail when someone adds an audience, which is the point:
that line should not change without the four steps above.

### Driver and dispatcher messages are mostly not marketing

Most of what anyone wants to send a driver — "your badge expires Friday", "the
park opens at 6" — is **operational**, not marketing. It belongs in
`NOTIFICATION_PRIORITY` at P2 and goes out through `NotificationService`, with
no consent gate, no campaign and no approval, because it is part of the service
the driver signed up to. Only genuine promotion ("refer a driver, earn ₦2,000")
needs the machinery in this document.

Getting this the wrong way round is the common mistake: routing operational
driver messages through the marketing queue would make them pausable, throttled,
retried on marketing's schedule and yield to nothing — a driver would learn
their shift changed some minutes after the fact.

---

## Adding a channel

Channels are already plural everywhere: a campaign has N channel rows, content
is validated per channel, consent is per channel, eligibility is per channel,
and the dashboard reports per channel. A fifth channel — WhatsApp is the likely
one in Nigeria — needs:

1. A `CommunicationChannel` enum value and a migration adding the consent column
   (`marketingWhatsapp`), defaulting **false**.
2. A kill switch in `communications_config.ts`, defaulting **false**, with its
   own `channelBlockers()` entry naming what is missing.
3. Content validation in `channel_content.ts` — every channel has its own limits
   (WhatsApp: template pre-approval by Meta, 24-hour session windows).
4. A queue and worker, if it sends in bulk. Reuse the `MarketingPushJob` shape;
   do **not** reuse the operational path.
5. A row in the dashboard's `channelStates()` and a provider entry in
   `providers()`.

Consent for a new channel is never inherited. `answerPrompt` already refuses to
grant SMS from a general yes, for exactly this reason: agreeing to email is not
agreeing to be messaged on WhatsApp.

---

## Adding a message type

Add it to `NOTIFICATION_PRIORITY` with an explicit priority. Nothing else.

An unlisted kind resolves to `CRITICAL` — the safe direction. A message wrongly
treated as critical is delivered promptly and annoys someone; a message wrongly
treated as marketing is throttled behind a promotion, and if it was a ride alert,
a passenger is standing on a road wondering where their driver is.

---

## What must not change

These are the load-bearing invariants. Anything that would break one is a
redesign, not an extension.

- **Operational notifications are never queued, throttled, paused or delayed.**
  They send inline. `NotificationService` does not import
  `OperationalPushHealth` for decisions — only to record. There is no channel
  name the emergency stop accepts that reaches them.
- **Marketing yields; nothing yields to marketing.** `mustYieldTo` is
  one-directional by construction, not by configuration.
- **Absence of consent is not consent.** No row means not opted in. There is no
  backfill and there never will be one.
- **The queues stay separate.** Shared: Firebase credentials, the FCM token
  registry, device registration. Not shared: queue, worker, rate limit, retry
  policy, reporting, audit trail, metrics.
- **Kill switches default off.** A new deployment sends nothing until someone
  turns it on deliberately.

---

## The one thing this design does not yet cover

Two-way communication. Everything here is outbound. A passenger replying to an
SMS, or a driver answering a WhatsApp template, has nowhere to arrive — there is
no inbox, no threading and no routing to a human. If inbound is ever wanted, that
*is* a new subsystem, and it should be built as one rather than bolted onto the
campaign model.
