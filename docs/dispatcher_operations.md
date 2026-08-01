# Dispatcher Operations

**Phases 4–5.** How a trained dispatcher at a Keke park actually works a shift,
and what the software does and does not let them do.

Written for two readers: the person training dispatchers, and the engineer who
gets paged when a park goes quiet.

Related: [`park_dispatch_mode_architecture.md`](park_dispatch_mode_architecture.md)
(why the system is shaped this way), [`park_operations_architecture.md`](park_operations_architecture.md)
(parks, rosters, badges, shifts), [`park_dispatch_integration.md`](park_dispatch_integration.md)
(how a ride reaches a park at all), [`launch_runbook.md`](launch_runbook.md)
(turning it on, and off).

---

## 1. The problem this solves

Many Keke drivers in Awka have no Android phone, or have one and keep mobile
data off because data costs money. Direct dispatch cannot reach them. Before
Park Dispatch, a ride that direct dispatch could not fill simply failed, even
when eleven drivers were sitting at a park four minutes away.

A dispatcher is a person at that park with a tablet who can see the request and
walk over to a driver. Park Dispatch is the software that puts the request in
front of them and records what they did.

**A dispatcher is not a driver, and not a supervisor.** They can claim a
request, choose a driver, and hand it over. They cannot advance a ride, touch
money, or read a passenger's phone number. That boundary is enforced on the
server, not by hiding buttons — see §7.

---

## 2. The screen

One screen, two panels, no navigation. An installable PWA served at
`/dispatch` from the same origin as the API — in production,
`https://dispatch.kekeride.ng`. `/dispatcher` still works so early bookmarks
keep opening.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Awka Main Park   [3 QUEUE] [0 MINE] [0 AWAITING] [4 READY] …  ● LIVE │
├───────────────────────────────┬──────────────────────────────────────┤
│ Incoming requests        (3)  │ Park drivers   2 can take a ride     │
│                               │                                      │
│  Amaka        ₦1,900   121s   │  Take Amaka's ride first, then       │
│  0815•••942 · cash            │  choose a driver.                    │
│  ● Zik Avenue                 │                                      │
│  ● Amaku                      │  1  Uche Aniete           U156       │
│  [URGENT] [WAITING 12M] …     │     #1 in queue · waiting now        │
│  ┌─────────────────────────┐  │     RECOMMENDED NEARBY SMARTPHONE    │
│  │     Take this ride      │  │                                      │
│  └─────────────────────────┘  │  2  Emeka Okafor          U214       │
│                               │     at the park                      │
│  Chioma       ₦1,500   121s   │     NEARBY SMARTPHONE                │
│  …                            │  …                                   │
├───────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ request  Enter take  1–9 assign driver  V verbal  K skip  E esc.  │
└──────────────────────────────────────────────────────────────────────┘
```

**There is no refresh button, and there is nothing to press to get new work.**
Socket.IO pushes every change. A 7-second poll runs alongside purely as a safety
net for a socket that dropped and has not yet reconnected; the connection pill
goes red the moment realtime is lost, so a dispatcher is never looking at a
stale board without knowing it.

### Counters

| Counter | Means |
|---|---|
| QUEUE | Requests waiting for this park to act |
| MINE | Requests **you** have claimed and not yet resolved |
| AWAITING | Offers sitting with a driver, waiting for them to answer |
| READY | Drivers present and free (presence-based) |
| ON TRIP / UNAVAIL / OFFLINE | The rest of the roster, by presence state |
| PARK USE | Active drivers as a share of park capacity |
| AVG WAIT | Mean seconds a passenger waited, on jobs finished today |
| RESPONSE | Median seconds from offer to claim, today |
| ASSIGNED / COMPLETED / FAILED / ESCALATED | Today's totals |

READY and "N can take a ride" are deliberately different numbers. READY counts
drivers who are present and free. "Can take a ride" additionally requires a
valid badge and a wallet in good standing. A driver with no badge is present,
free, and still not assignable — the list shows them, greyed, with the reason,
so the dispatcher can fix it rather than wonder.

---

## 3. Working a request

### The normal flow

1. A request arrives. The board chimes, the tablet buzzes, the card slides in,
   the tab title shows a count.
2. **Take this ride** (or `Enter`). This *claims* it — you own it, and it
   disappears from every other dispatcher's actionable set.
3. The driver panel re-ranks itself for that specific ride and tells you who to
   ask first.
4. **Tap a driver.** A short review sheet appears: their photo and unit, the
   pickup, destination, passenger and fare, and which handoff applies.
5. **Confirm once.** That is the assignment.

Two steps, not one. The first version assigned on the first tap, on the
reasoning that a dispatcher with a passenger waiting should not have to confirm
what they deliberately pressed. That holds right up until the list re-ranks
under a moving thumb — and then it hands a real trip to the wrong driver with
no moment at which anyone could have noticed. The sheet costs one tap.

Keyboard equivalents exist for every step (`↑↓`, `Enter`, `1`–`9`, `V`, `K`,
`E`, `/`, `S`) because a tablet on a counter with a keyboard is faster than
tapping, and some parks will run this on a desktop. `1`–`9` and `V` open the
sheet; nothing assigns without the confirm.

### What happens next depends on the driver's phone

| Driver | What Assign does |
|---|---|
| **Smartphone** | Sends the offer to their device — the same card, countdown and Accept/Decline they already know from direct dispatch. The job goes to `pending_acceptance` and the dispatcher's card counts down. |
| **Feature phone** | You have *already spoken to them*. The sheet says "Verbal handoff"; confirming makes the ride theirs immediately. |

The verbal path is not a degraded fallback; it is the primary path for most of
the fleet. The dispatcher walking three metres and asking "Uche, Zik Avenue to
Amaku, ₦1,900?" is a faster and more reliable confirmation than a push
notification to a phone with data turned off.

### Recommended drivers

The top driver carries a `RECOMMENDED` badge. Exactly one driver ever does.
Ranking weights, in order: waiting for work (40), at the park (28), position in
the park queue (15), historical acceptance rate (10), light workload today (7).
A driver who cannot take the ride scores zero and sinks, with a badge saying
why — `NO BADGE`, `WALLET BLOCKED`, `BUSY`, `OFFLINE`, `OUT OF PARK`,
`SUSPENDED`, `DECLINED THIS RIDE`.

Queue position matters because park queues are a real social institution. A
dispatcher who repeatedly skips the front of the queue will be argued with, and
correctly so.

**Ranking is advice, not a rule.** The dispatcher can assign anyone assignable.
They can see the park; the server cannot.

### Skip, reject, escalate

- **Skip** (`K`) — this park cannot serve it right now. Returns it for another
  park or normal failure.
- **Reject** (`E` is escalate; reject is on the card) — deliberate refusal, with
  a reason, audited.
- **Escalate** — hand it to a supervisor. Use when something is wrong that a
  dispatcher should not decide alone.

---

## 4. When a driver disappears after being assigned

This is the failure mode that matters most, and the one that used to strand
passengers.

A smartphone driver has **18 seconds** (`PARK_DRIVER_ACCEPT_WINDOW_MS`) to
answer. Three things can happen:

| | What the system does |
|---|---|
| **Accepts** | Ride becomes theirs through the same conditional UPDATE a direct acceptance uses. Job resolved. |
| **Declines** | Job returns to `claimed` — still yours. The driver is marked `DECLINED THIS RIDE` and drops in the ranking. Pick someone else. |
| **Says nothing** | The sweeper expires the offer within 10 seconds of the deadline and returns the job to your queue exactly as a decline would. |

The undeliverable case is handled before the clock starts: if the offer cannot
be put on the driver's device at all — app closed, no socket, push unavailable —
the assignment is **refused immediately** and handed straight back, rather than
burning 18 seconds waiting for a phone that was never going to ring.

**A ride cannot become stuck on a driver who vanished.** The three exits
(accept, decline, expire) are exhaustive, the sweeper runs every 10 seconds
independent of anyone's browser being open, and the ride stays `searching`
throughout — so if the park phase runs out entirely, the ordinary stale-ride
recovery still owns it.

---

## 5. Passengers are never asked to do anything

No PIN. No QR code. No extra confirmation. A passenger who books a ride and gets
one assigned from a park sees the same thing they always see: a driver was
found. The park is an implementation detail of *how* the driver was found, and
the passenger should never have to learn it exists.

During the park phase the passenger app shows "Still searching nearby…" — which
is true — via a `ride:dispatch_round` event that also re-arms its 150-second
client-side watchdog. That matters for builds **already in the field**: without
it, an app installed before Park Dispatch shipped would declare a timeout while
the server was still working.

---

## 6. Contact privacy

The queue card shows a passenger's **first name** and a **masked** number
(`0815•••942`). A dispatcher needs to greet someone, not identify them.

Revealing a full number is a **support** action, not a park one. It needs
`monitor:reveal_contact`, which only SUPER_ADMIN and SUPPORT_OFFICER hold —
deliberately, not by oversight. A park supervisor cannot do it either.

So a dispatcher who genuinely needs to reach a passenger escalates the request
and support makes the call, through
`POST /admin/live-requests/:rideId/reveal-contact` — audited, with a reason.

The driver gets the passenger's contact through the existing ride flow once
assigned, exactly as with direct dispatch. The dispatcher is never in that path.

---

## 7. What a dispatcher cannot do

Enforced server-side. The dashboard states it explicitly as
`capabilities.canAdvanceRideLifecycle: false`, and there is **no endpoint** that
would let them:

- advance a ride — no arrival, no start, no completion;
- touch a wallet, a fare, or a payment;
- read an unmasked passenger number;
- assign a driver at a park they are not on shift at;
- disable Park Dispatch (that needs `PARK_SUSPEND`, which they do not hold).

The client has no code path for any of it either, but the client is not the
control. Every dispatcher action is audited with who, what, when, which park,
which ride, and from which address.

---

## 8. Shifts

A dispatcher must **open a shift** at a park before they can claim or assign.
One open shift per dispatcher, enforced by a partial unique index rather than by
application logic — two devices cannot both believe they are on duty.

Ending a shift with claimed jobs returns those jobs to the queue. Supervisors
can force-close a shift when someone walks off with a tablet still logged in.

---

## 9. When something looks wrong

**"No requests are arriving."** Two very different causes, and the screen tells
you which: if Park Dispatch has been paused centrally, a red banner says so and
gives the reason. If there is no banner, there is genuinely no work — direct
dispatch is filling rides, which is the system working as intended. Park
Dispatch only ever sees what direct dispatch could not fill.

**"The connection pill is red."** Realtime is down; the 7-second poll is
carrying the board. Work continues. If it stays red, the tablet's data is the
first thing to check.

**"A driver is listed but greyed out."** The badge says why. `NO BADGE` needs a
supervisor to issue one; `WALLET BLOCKED` needs the driver to settle up before
taking another cash ride.

**"I assigned someone and nothing happened."** Check AWAITING. A smartphone
driver has 18 seconds; the card is counting down. If it returns to your queue,
they declined or did not answer, and you pick someone else.

For engineer-side diagnosis — Redis keys, admin endpoints, the sweeper — see
[`launch_runbook.md`](launch_runbook.md) §4.
