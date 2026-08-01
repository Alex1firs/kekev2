# Dispatcher Web Push — Infrastructure Audit

Written **before** any code change, as required. This records what exists, what
is safely reusable for a browser, and what is genuinely new.

Date: 2026-08-01

---

## 1. What exists today

### 1.1 Firebase project

One project serves everything:

| | |
|---|---|
| Project ID | `keke-ride-75ae8` |
| Project number | `889922883046` |
| Driver Android app | `ng.kekeride.driver` — `1:889922883046:android:9285fcb73bf8e7c9de5a27` |
| Passenger Android app | `ng.kekeride.passenger` — `1:889922883046:android:ca7ef7fd3985b828de5a27` |
| iOS | `GoogleService-Info.plist` present for both apps |
| Admin SDK service account | `firebase-adminsdk-fbsvc@keke-ride-75ae8…` — **same project** |

The backend's service account is in the same project as the mobile apps, which
is what makes a shared backend notification service possible at all.

### 1.2 Credential handling

`NotificationService.initialize()` prefers `FIREBASE_SERVICE_ACCOUNT_JSON`
(base64 JSON) and falls back to `src/config/firebase-admin.json` for
development. That file is **gitignored and not tracked** — verified:

```
apps/keke_backend/.gitignore:6:src/config/firebase-admin.json
git ls-files → not tracked
```

Production sets the env var; without it the service logs
`Push notifications DISABLED` and every send returns
`reason: 'push_disabled'`. That is the honest failure mode, and it is how push
was silently off in production until 2026-07-11.

### 1.3 Token storage

`DeviceToken`:

| Column | Note |
|---|---|
| `userId` | a **customer** `User.id` |
| `role` | `UserRole` — `passenger` \| `driver` \| `admin` |
| `platform` | `"ios" \| "android"` — **no web** |
| `token` | unique |
| `isActive` | flipped false when FCM reports the token unregistered |

Registration is `POST /notifications/tokens` behind `authMiddleware`, the
**customer** JWT middleware. A StaffUser has no `User` row and no customer
token, so a dispatcher cannot register here today — and must not be able to.

### 1.4 Sending

`NotificationService.sendToUser(userId, role, title, body, data)`:

- looks up active tokens for that user and role;
- 2-second Redis dedup on `notif:{userId}:{type}:{rideId}`;
- routes Android to a high-importance **channel** — `keke_ride_requests` for
  driver offers, `keke_ride_updates` for passenger updates — because on
  Android 8+ the sound belongs to the channel, not the message;
- sets an APNs payload with sound and badge;
- deactivates tokens FCM rejects as invalid or unregistered;
- returns a `PushResult` distinguishing `no_active_tokens`, `push_disabled`,
  `deduplicated` and `send_failed`.

### 1.5 Delivery evidence that already exists

`DispatchEvent` already models delivery honestly, and this is the model to
extend rather than reinvent:

| Event | Means |
|---|---|
| `NOTIFICATION_QUEUED` | handed to the transport |
| `SOCKET_OFFER_EMITTED` | written to a socket that was connected at that moment |
| `FCM_ACCEPTED_BY_PROVIDER` | **provider acceptance — NOT device delivery** |
| `OFFER_DELIVERY_FAILED` | neither transport could carry it |
| `DEVICE_OFFER_ACK` | the app confirmed the offer actually rendered |

`dispatch_monitor_query_service` already refuses to call provider acceptance a
delivery. The comment in `DispatchEvent.ts` says it outright: acceptance is not
proof anyone saw anything.

---

## 2. Can the same Firebase project serve the dispatcher web app?

**Yes — with a separate Web App registration. The Android configuration cannot
be reused.**

A Firebase project supports Android, iOS and Web apps side by side, all
reachable from one Admin SDK credential. So the backend service, the service
account and the sending code all carry over unchanged.

What does **not** carry over:

| Thing | Why not |
|---|---|
| `google-services.json` | Android-specific. Its `mobilesdk_app_id` is an *android* app id; there is no web app id in it, and no API key valid for the JS SDK. |
| Android notification channels | An Android OS concept. The web has no channels; the browser and OS decide sound and importance. |
| The custom `keke_ring.wav` | Android app assets. A web push cannot ship a bundled sound file — see §4. |
| APNs config | iOS-only. |

What is **new and required**:

1. A **Web App registration** in the Firebase console → gives `apiKey`,
   `authDomain`, `projectId`, `messagingSenderId`, `appId`. These are **public
   identifiers, not secrets** — they ship in the browser by design, and Firebase
   documents them as such. Access control comes from security rules and from our
   own StaffUser auth, never from hiding these values.
2. A **Web Push certificate (VAPID key pair)**, generated in
   *Project settings → Cloud Messaging → Web configuration*. The browser needs
   the **public** key. The private half never leaves Firebase.
3. A **messaging service worker** at a fixed path, which Firebase requires to
   receive background messages.
4. A **staff-scoped token store** — see §3.

**The Admin service account must never reach the browser.** Nothing in the web
configuration above is that credential, and nothing in this work moves it.

---

## 3. Why staff tokens need their own table

`DeviceToken` cannot hold a dispatcher token without lying about its own
columns:

- `userId` is a customer `User.id`; a dispatcher is a `StaffUser` in a separate
  table with a separate JWT audience. Overloading the column would put two
  different kinds of identity in one foreign key with no way to tell them apart.
- `role` is `UserRole`, which has no dispatcher value. Adding one would make
  `admin` and `PARK_DISPATCHER` look like the same kind of thing to every
  existing query that filters on it.
- `platform` has no `web`.
- A dispatcher token needs **park**, **shift** and **device** association, which
  a customer token has no concept of.
- The registration endpoint sits behind customer auth. Reusing it would mean
  either widening that middleware to accept staff tokens — exactly the
  separation Phase 1 built — or adding a second door into the same table.

So: a new `StaffDeviceToken`, staff-authenticated, park-scoped. The **sending**
path still goes through `NotificationService` and the same Firebase Admin SDK;
only the token lookup differs.

---

## 4. Honest limits of Web Push on Android

Stated plainly, because §4 of the brief asks for it and because overstating this
is how a park ends up with a silent dispatcher.

**What the web genuinely gets:**

- A notification while the browser process is alive but backgrounded, or the
  screen is locked — delivered by the service worker, shown by the OS.
- A notification when the installed PWA is closed, **provided the browser
  process still exists**. On stock Android with Chrome, this generally works:
  Chrome keeps a background service that FCM wakes.
- `vibrate` in the notification options, honoured on most Android builds.
- An icon, a badge, a `tag` for deduplication, and `requireInteraction`.

**What the web cannot do, and no amount of code changes:**

| Limitation | Consequence |
|---|---|
| **No custom sound.** The Web Notifications API has no sound property that Chrome on Android honours. The notification plays the **OS default notification tone** at the phone's notification volume. | The distinctive `keke_ring` used by the driver app is not available. The dispatcher hears the phone's normal notification sound. |
| **No notification channels.** The web cannot create a high-importance channel with its own sound, unlike the Android apps. | Importance is whatever the browser's own channel is set to. The user can change it in Android settings under Chrome. |
| **Aggressive OEM battery management.** Xiaomi/MIUI, Huawei/EMUI, Oppo/ColorOS and Samsung's adaptive battery routinely kill or throttle Chrome's background process. | On those devices a *fully closed* PWA may receive nothing until the browser is reopened. This is not fixable from our code. |
| **Doze mode.** With the screen off and the phone stationary, delivery may be deferred unless the message is high priority — and even then OEM layers may override. | A push at 04:00 to a pocketed phone may arrive late. |
| **The user can block notifications**, per-site, and Android can block Chrome entirely. | Handled by §6: a dispatcher must not start a shift silently. |

**Therefore:** Web Push materially improves on the current open-tab-only
behaviour and is the right thing to build. It does **not** make the phone a
pager. The operating procedure must still keep the app open where possible, and
the setup screen must surface a broken notification state before a shift starts
rather than after a passenger has waited.

Anyone who tells you a PWA notification is as reliable as a native
foreground-service alarm on a Nigerian mid-range Android is wrong, and the
physical test is where that gets settled.

---

## 5. What this work will add

| | |
|---|---|
| `StaffDeviceToken` | staff-scoped token store: StaffUser, park, shift, device label, platform `web`, `isActive` |
| `StaffPushService` | registration, refresh, deactivation, and send-to-park-dispatchers |
| `firebase-messaging-sw.js` | background message handler for the dispatcher PWA |
| Web config endpoint | serves the **public** Firebase web config + VAPID public key to an authenticated staff session, so nothing is baked into a committed file |
| `StaffPushDelivery` | delivery evidence rows, distinguishing queued / accepted / SW-received / opened / failed / invalid / denied |
| Escalation | initial push, one reminder, optional final before expiry, hard stop on claim/assign/cancel/expire/suspend |
| Setup and diagnostics screen | permission, token, SW, park, shift, last push, last open, tests, and a **block on starting a shift silently** |

Nothing above changes how the driver or passenger apps are notified.

---

## 6. Configuration required before the physical test

These must be done in the Firebase console by someone with access; they cannot
be done from this repository.

1. **Add a Web App** to `keke-ride-75ae8`
   (*Project settings → General → Your apps → Add app → Web*).
   Name it `KekeRide Park Dispatch`. Copy the config object.
2. **Generate a Web Push certificate**
   (*Project settings → Cloud Messaging → Web configuration → Generate key pair*).
   Copy the **public** key.
3. Set on the backend:

```
FIREBASE_WEB_API_KEY=…
FIREBASE_WEB_APP_ID=1:889922883046:web:…
FIREBASE_WEB_MESSAGING_SENDER_ID=889922883046
FIREBASE_WEB_PROJECT_ID=keke-ride-75ae8
FIREBASE_WEB_AUTH_DOMAIN=keke-ride-75ae8.firebaseapp.com
FIREBASE_VAPID_PUBLIC_KEY=…
```

The first five are public identifiers. The VAPID **public** key is also public
by definition. `FIREBASE_SERVICE_ACCOUNT_JSON` stays server-only and is
unchanged.

Until these are set, the dispatcher app will report push as unavailable on the
setup screen and say why — it will not fail silently or pretend to be armed.
