# Park Dispatch — Launch Checklist

Everything that has to be true before dispatchers start work, and who does it.

Staging is deployed and the software flow is verified end to end. **Two items
are blocking and both need a human**: the Firebase Web App, and the phone test.

---

## A. Firebase Console — you must do this (≈10 minutes)

Nothing about Web Push works until this exists. There is no way to do it from
the repository, and nothing already in the project can be reused: the Android
`google-services.json` holds an *android* app id and no web API key.

### A1. Create the Web App

1. Open <https://console.firebase.google.com> and select **`keke-ride-75ae8`**
   (project number `889922883046` — the same project the driver and passenger
   apps already use).
2. **Project settings** (gear, top-left) → **General** tab.
3. Scroll to **Your apps**. You will see the Android and iOS apps already
   registered.
4. Click **Add app** → choose the **Web** icon (`</>`).
5. App nickname: **`KekeRide Park Dispatch`**.
6. Leave **"Also set up Firebase Hosting"** UNCHECKED — the app is served by our
   own backend, not by Firebase.
7. Click **Register app**.
8. Firebase shows a `firebaseConfig` object. Copy these five values:

```js
const firebaseConfig = {
  apiKey:            "AIza…",                          // → FIREBASE_WEB_API_KEY
  authDomain:        "keke-ride-75ae8.firebaseapp.com", // → FIREBASE_WEB_AUTH_DOMAIN
  projectId:         "keke-ride-75ae8",                 // → FIREBASE_WEB_PROJECT_ID
  messagingSenderId: "889922883046",                    // → FIREBASE_WEB_MESSAGING_SENDER_ID
  appId:             "1:889922883046:web:…"             // → FIREBASE_WEB_APP_ID
};
```

9. Click **Continue to console**.

### A2. Generate the Web Push certificate (VAPID key)

1. Still in **Project settings**, open the **Cloud Messaging** tab.
2. Scroll to **Web configuration** → **Web Push certificates**.
3. If the list is empty, click **Generate key pair**.
4. Copy the **Key pair** value shown. It is a long string beginning `B…`.
   → `FIREBASE_VAPID_PUBLIC_KEY`

That is the **public** half. The private half never leaves Google and you will
never see it.

### A3. Check Cloud Messaging API is enabled

Same tab, near the top: **Firebase Cloud Messaging API (V1)** should read
**Enabled**. If it says disabled, click through and enable it. The mobile apps
already use it, so it almost certainly is.

> **Note on secrecy:** all six values above are *public client identifiers*.
> They ship inside every web app that uses Firebase and are visible in the
> browser by design. They are not credentials. The thing that IS a credential —
> `FIREBASE_SERVICE_ACCOUNT_JSON`, the Admin service account — is already set on
> the server, is unchanged by any of this, and must never appear in a browser.

---

## B. Environment variables

### B1. Required for Web Push (new)

Add all six to `/opt/kekev2/apps/keke_backend/.env` on the droplet:

```bash
FIREBASE_WEB_API_KEY=AIza…
FIREBASE_WEB_AUTH_DOMAIN=keke-ride-75ae8.firebaseapp.com
FIREBASE_WEB_PROJECT_ID=keke-ride-75ae8
FIREBASE_WEB_MESSAGING_SENDER_ID=889922883046
FIREBASE_WEB_APP_ID=1:889922883046:web:…
FIREBASE_VAPID_PUBLIC_KEY=B…
```

Then:

```bash
cd /opt/kekev2/apps/keke_backend
docker compose up -d api_staging      # staging first
# later, for production:
docker compose up -d api_prod
```

Confirm it took (should print `"available": true`):

```bash
curl -s https://staging.kekeride.ng/api/v1/dispatcher/push/config \
  -H "Authorization: Bearer $STAFF_TOKEN" | head -3
```

### B2. Already set — do not change

| Variable | State |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | set; sends every push, mobile and web |
| `STAFF_JWT_SECRET` | **generated and set during this deployment** |
| `PARK_DISPATCH_ENABLED` | defaults `true` |
| `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `ADMIN_API_KEY` | unchanged |

### B3. Optional tuning

| Variable | Default | Effect |
|---|---|---|
| `PARK_PUSH_ENABLED` | `true` | Master switch for dispatcher push |
| `PARK_PUSH_REMINDER_MS` | `12000` | Delay before the one reminder |
| `PARK_PUSH_FINAL_BEFORE_EXPIRY_MS` | `8000` | Final call, measured back from expiry |
| `PARK_DRIVER_ACCEPT_WINDOW_MS` | `18000` | How long a smartphone driver has |

---

## C. What is already done

| | Status |
|---|---|
| Merged to `main` | `579b5376`, pushed |
| Rollback tag | `pre-park-dispatch` → `f0e36fa` |
| Staging deployed | `api_staging` running from `main` |
| Migrations on staging | 26 applied, including the enum repair |
| Dispatcher URL | **`https://staging.kekeride.ng/dispatch/`** |
| HTTPS | Valid cert (SAN covers `staging.kekeride.ng`) |
| Service worker | Registers and controls the page over HTTPS |
| Basic auth | Off for `/dispatch`, `/api/`, `/socket.io/`, `/uploads/`; still on elsewhere |
| Staging park | `AWK-PILOT` active, zones, 2 drivers, 1 passenger |
| Scoping control | `AWK-OTHER` — dispatcher must never see it |
| Backups | Staging DB dumped to `/root/keke_staging_pre_park_*.sql.gz` |

---

## D. Automated verification — all green

| Check | Result |
|---|---|
| Backend suite | **563 passed**, 25 suites |
| TypeScript (`src` + `scripts`) | clean |
| PWA audit **against staging HTTPS** | **19/19** |
| End-to-end launch flow **against staging** | **18/18** |
| Migration chain: virgin + production-shaped | both pass |
| Real-click UI test | pass, no CSP violations |
| Acceptance scenarios A–O | 17/17 |

The end-to-end run proves, on the deployed environment:

```
passenger requests → direct dispatch finds nobody → park receives it
→ dispatcher opens it → drivers ranked → dispatcher assigns
→ driver's device receives the offer → driver accepts
→ passenger sees "Sunday Okonkwo · AWK-T101 · Keke NAPEP"
→ dispatchMode=park, assignmentMode=electronic
→ request cleared from the queue
```

---

## E. The phone test — nobody has done this

Do it on the real dispatcher handset, at `https://staging.kekeride.ng/dispatch/`.
**Do not use `chrome://flags/#unsafely-treat-insecure-origin-as-secure`** — a PWA
behaves differently under it and the result would not mean anything.

Full 27-row matrix: `docs/park_dispatch_physical_acceptance_report.md` §12.
The short version, in order:

| | Step | Must be true |
|---|---|---|
| 1 | Open the URL on the phone | Loads over HTTPS |
| 2 | Install to home screen | Prompt appears; diamond icon |
| 3 | Open from home screen | No address bar |
| 4 | Sign in as `dispatcher.test@kekeride.ng` | Works |
| 5 | Shift screen → **Set up** background alerts | Permission prompt, then "On" |
| 6 | **Send test** | Notification arrives |
| 7 | **Is it audible at normal volume?** | **Yes** ← critical |
| 8 | Does it vibrate? | Yes |
| 9 | Start the shift | No silent-shift warning |
| 10 | **Lock the screen**, trigger a request | Notification on the lock screen ← critical |
| 11 | **Fully close the app**, trigger another | Still arrives ← critical |
| 12 | Tap it | Opens **that** request ← critical |
| 13 | Assign a smartphone driver | Works |
| 14 | Assign the feature-phone driver verbally | Works |
| 15 | Leave one unanswered ~15 s | **One** reminder, not a stream |
| 16 | Let one expire | Final call, then silence |
| 17 | Repeat on mobile data, not Wi-Fi | Still arrives |
| 18 | Restart the phone, open once, lock, trigger | Still arrives |

To trigger a real request during the test, from your machine:

```bash
cd apps/keke_backend
E2E_BASE=https://staging.kekeride.ng \
DISPATCHER_EMAIL=dispatcher.test@kekeride.ng DISPATCHER_PASSWORD=… \
CUSTOMER_PASSWORD=… npx ts-node scripts/e2e_launch_flow.ts
```

It takes about two minutes — most of it waiting for direct dispatch to exhaust,
which is the real behaviour and cannot be shortened.

### If rows 10–11 fail on a non-stock Android

Expected on Xiaomi/MIUI, Huawei/EMUI, Oppo/ColorOS and aggressive Samsung
battery settings. These kill Chrome's background process, and a killed browser
receives nothing. **This is not fixable in our code.**

1. Record the device and skin.
2. Settings → Apps → Chrome → Battery → **Unrestricted**, and add Chrome to
   protected/auto-start apps.
3. Retest. If it still fails, that phone is unsuitable as a dispatcher device.

---

## F. Production cutover — after the phone test passes

Not before. Staging is where a failure is cheap.

```bash
# on the droplet
cd /opt/kekev2 && git pull --ff-only

# 1. Back up production
docker compose -f apps/keke_backend/docker-compose.yml exec -T postgres_shared \
  pg_dump -U postgres keke_prod_db | gzip > /root/keke_prod_pre_park_$(date +%F-%H%M).sql.gz

# 2. Build, migrate, restart (~10s of 502s)
cd apps/keke_backend
docker compose build api_prod
docker compose run --rm api_prod npm run migration:run
docker compose up -d api_prod

# 3. Smoke test
curl -s https://api.kekeride.ng/health
curl -s -o /dev/null -w "%{http_code}\n" https://api.kekeride.ng/dispatch/
```

Then create the real park and staff:

```bash
docker compose run --rm --no-deps \
  -v /opt/kekev2/apps/keke_backend/scripts:/app/scripts:ro \
  -v /opt/kekev2/apps/keke_backend/src:/app/src:ro \
  -v /opt/kekev2/apps/keke_backend/tsconfig.json:/app/tsconfig.json:ro \
  -e BOOTSTRAP_OPS_EMAIL=… -e BOOTSTRAP_OPS_PHONE=… \
  -e BOOTSTRAP_SUPERVISOR_EMAIL=… -e BOOTSTRAP_SUPERVISOR_PHONE=… \
  -e BOOTSTRAP_DISPATCHER_EMAIL=… -e BOOTSTRAP_DISPATCHER_PHONE=… \
  -e BOOTSTRAP_PARK_LAT=6.2109 -e BOOTSTRAP_PARK_LNG=7.0740 \
  api_prod npx ts-node scripts/bootstrap_production.ts --check
```

`--check` changes nothing. Re-run with `--apply` when the output looks right; it
prints one-time activation links, once, to hand over in person.

### The shorter path — `--super-admin-only`

The command above wants four people and a set of coordinates before it will do
anything, which assumes the whole team is hired and somebody has already stood
in the park with a phone. Usually only the first account exists:

```bash
docker compose run --rm --no-deps \
  -v /opt/kekev2/apps/keke_backend/scripts:/app/scripts:ro \
  -v /opt/kekev2/apps/keke_backend/src:/app/src:ro \
  -v /opt/kekev2/apps/keke_backend/tsconfig.json:/app/tsconfig.json:ro \
  -e BOOTSTRAP_SUPERADMIN_EMAIL=… -e BOOTSTRAP_SUPERADMIN_PHONE=… \
  -e "BOOTSTRAP_SUPERADMIN_NAME=…" \
  api_prod npx ts-node scripts/bootstrap_production.ts --super-admin-only --apply
```

Everything else is then made from the dashboard: SUPER_ADMIN is the only role
holding `staff:create`, and the OPERATIONS_ADMIN it grants creates parks.

**Prefer that route.** An account created by this script is attributed to
`BOOTSTRAP`; one created through the dashboard is attributed to the named human
who created it, with a reason, in the audit log.

> **`DISPATCH_PUBLIC_URL` is per-environment.** Both `api_prod` and
> `api_staging` read the one shared `.env`, so a bare `${DISPATCH_PUBLIC_URL}`
> could only ever be right for one of them — production spent a period minting
> activation links that pointed at staging, where the account does not exist.
> Each service now carries its own default; override with
> `DISPATCH_PUBLIC_URL_PROD` / `DISPATCH_PUBLIC_URL_STAGING`, never the bare
> name. `--super-admin-only` refuses to run if links would come out relative.

**Done on production 2026-08-02:** SUPER_ADMIN `corrosivedon@gmail.com`
(Alexander Nwabufoh), invited. No park yet — it is created from the dashboard,
with coordinates read standing in it.

### Dedicated subdomain (optional, not on the critical path)

`https://api.kekeride.ng/dispatch/` works with no DNS change. For
`dispatch.kekeride.ng`: A record → `206.189.96.147`, then the block in
`deploy/dispatch.kekeride.ng.nginx.conf`, then certbot with the deploy-hook —
see `launch_runbook.md` §3c. **The deploy-hook is not optional**; a renewed
certificate nginx has not reloaded is what caused the July 2026 outage.

---

## G. If something goes wrong on Monday

In order of cost:

1. **Suspend Park Dispatch** — seconds, no deploy. Operations dashboard →
   Park Dispatch → Suspend, with a reason. Needs a real staff login; the shared
   admin key cannot do it. Rides already assigned continue.
2. **Environment off** — `PARK_DISPATCH_ENABLED=false`, restart. ~10s of 502s.
3. **Roll back the code** — `git revert -m 1 579b5376`, rebuild, restart.

**Leave the migrations in place** in all three cases. They are additive, the old
code ignores the new columns, and reverting them would drop tables that live
jobs still reference.

Direct dispatch is unaffected by all of the above — it never changed.
