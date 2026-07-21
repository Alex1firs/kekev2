# Driver Background Reliability — Verification & Hand-off

Branch: `feat/driver-background-reliability` · Rollback checkpoint: `26a658f` (main)
**Not merged / not deployed** — final sign-off is the physical 30-minute locked-screen test below.

## What changed and why

The audit found the native foreground service **already existed and was correct** — the heartbeat runs inside the Android foreground-service isolate with a wake lock, not a JS timer. So the ~1–2-minute stop when the screen locks is almost certainly **OEM battery-killers** (Transsion Tecno/Infinix/itel, Xiaomi, Oppo, Vivo) killing the service unless the app is in their proprietary auto-start/protected-app list — which is separate from the standard battery-optimization exemption.

This change hardens reliability around that root cause:

| Area | Change |
|---|---|
| OEM battery guidance | `oem_battery_service.dart` — detects manufacturer, shows device-specific auto-start/protected-app steps, opens the OEM settings intent |
| Diagnostics | `diagnostics_screen.dart` + `driver_diagnostics.dart` — live view of online-intent / service running / heartbeat age / location age / permissions / battery / FCM token / network / **dispatch eligibility + blocking reason**; recent event log |
| Background location | Runtime escalation to "Allow all the time" on go-online (`_ensureBackgroundLocation`) |
| Locked-screen ride ring | `ride_notification_service.dart` — creates the high-importance `keke_ride_requests` channel client-side (loud heads-up + `keke_ring` over the lock screen), full-screen-intent capable, de-duplicated by rideId |
| Heartbeat payload | Now sends accuracy, speed, heading, location timestamp, app version, platform + rejects stale last-known fixes; writes freshness markers for the diagnostics screen |
| Structured logging | `reliability_log.dart` — `[KEKE_REL]` tagged, greppable in logcat, buffered for the diagnostics screen |
| Manifest | `USE_FULL_SCREEN_INTENT`, `RECEIVE_BOOT_COMPLETED` |

**Backend note:** the HTTP `/drivers/heartbeat` from the foreground service is already sufficient to keep a driver in the Redis dispatch pool (availability key). The socket `driver:heartbeat` is **not** required for availability, so it was intentionally not added to the service isolate. Dispatch eligibility is server-authoritative (Redis), never client UI state.

## Files changed
- Added: `lib/core/services/reliability_log.dart`, `oem_battery_service.dart`, `ride_notification_service.dart`, `driver_diagnostics.dart`; `lib/features/driver/presentation/diagnostics_screen.dart`; this doc.
- Modified: `lib/core/services/location_foreground_task.dart`, `lib/core/network/notification_service.dart`, `lib/features/driver/application/driver_controller.dart`, `lib/features/driver/presentation/driver_home_screen.dart`, `lib/core/routing/app_router.dart`, `lib/main.dart`, `android/app/src/main/AndroidManifest.xml`, `pubspec.yaml`.
- New deps: `device_info_plus`, `package_info_plus`, `connectivity_plus`, `flutter_local_notifications`, `android_intent_plus`.

## How to read it while testing
- **Diagnostics screen:** open the driver app → tap the **📶 (wifi_tethering)** icon in the top bar. Everything updates every 3s. The top card shows **Online and ready** or the exact **blocking reason**.
- **Logcat (with a cable):** `adb logcat | grep KEKE_REL` — you'll see `fgs_started`, `heartbeat_sent status=200`, `location_obtained`, `fcm_received`, `battery_restriction_detected`, `became_stale`, etc.
- **Admin Live Riders:** confirms server-side heartbeat freshness for the same driver.

---

## Physical test matrix (required before deploy)

Devices: **(1)** a Tecno/Infinix/itel, **(2)** a Samsung or Pixel, **(3)** a passenger phone, plus the **Admin → Live Riders** dashboard.

Do the OEM battery setup below FIRST on each driver phone, then:

| # | Step | Expected |
|---|---|---|
| A | Toggle Online | Diagnostics top card = "Online and ready"; Live Riders shows the driver Actively Online |
| B | Confirm fresh heartbeat | Diagnostics heartbeat "Fresh", age < 45s; Live Riders age < 45s |
| C | Lock screen 2 min | Still Actively Online; heartbeat age stays < 45s (check Live Riders after unlock) |
| D | Confirm | Heartbeat fresh throughout |
| E | Lock screen 10 min | Still Actively Online |
| F | Confirm | Heartbeat fresh throughout |
| G | Lock screen 30 min | **Still Actively Online the whole time** (the acceptance criterion) |
| H | Confirm | Live Riders never flips to Stale/Offline |
| I | Passenger requests a ride while phone still locked | Driver phone rings + heads-up ride notification appears over the lock screen |
| J | Confirm | Audible `keke_ring` + visible alert |
| K | Accept the ride | Assignment succeeds; Live Riders shows On Trip |
| L | Confirm | Passenger sees driver assigned |
| M | Open another app while Online | Heartbeat continues; a new request still rings |
| N | Confirm | Still dispatch-eligible |
| O | Enable battery saver, repeat C–I | Still online + receives rides (proves OEM setup holds under saver) |
| P | Reboot phone | Service does NOT auto-start (by design, `autoRunOnBoot:false`). App shows Offline until the driver re-opens and it auto-resumes. Document this to drivers: **after a reboot, open the app once.** |
| Q | Toggle Offline | Diagnostics service "No"; Live Riders Offline immediately; logcat `offline_stopped` + `fgs_stopped` |

Record for each phone: model, Android version, and the longest continuous locked-online duration achieved.

> **Sign-off:** deploy only after **G/H pass on the Transsion device** (the hardest case). If it still goes stale, the diagnostics screen's blocking reason + `KEKE_REL` log will say why (almost always battery restriction → the OEM step below wasn't applied/held).

---

## OEM-specific settings (walk the driver through these once)

The app's Diagnostics screen shows these per-device and has an **"Auto-start settings"** button that jumps to the right screen. Manual steps:

**Tecno (HiOS)**
1. Phone Master / Settings → App management → **Auto-start** → enable KekeRide Driver.
2. Settings → Battery → allow KekeRide to **Run in background** / "No restrictions".
3. Settings → Apps → KekeRide → Battery → **Unrestricted**.

**Infinix (XOS)**
1. Phone Master / Settings → App management → **Auto-start** → enable KekeRide.
2. Settings → Battery → "Background freeze" / "Power-intensive apps" → allow KekeRide.
3. Settings → Apps → KekeRide → Battery → **No restrictions**.

**itel (itel OS)**
1. Settings → App management (or Phone Master) → **Auto-start** → enable KekeRide.
2. Settings → Battery → allow background running.
3. Settings → Apps → KekeRide → Battery → **Unrestricted**.

**Samsung (One UI)**
1. Settings → Apps → KekeRide → Battery → **Unrestricted**.
2. Settings → Battery → Background usage limits → ensure KekeRide is NOT in "Sleeping/Deep sleeping"; add to **Never sleeping apps**.

**Xiaomi (MIUI / HyperOS)**
1. Settings → Apps → Manage apps → KekeRide → enable **Autostart**.
2. Same page → Battery saver → **No restrictions**.
3. Recents → swipe down on the KekeRide card → tap the **lock** icon.

**Oppo (ColorOS)**
1. Settings → Battery → App battery management → KekeRide → allow background running.
2. Settings → Apps → KekeRide → **Allow auto launch**.
3. Recents → lock the KekeRide card.

**Vivo (Funtouch OS / OriginOS)**
1. Settings → Battery → Background power consumption management → KekeRide → allow.
2. Settings → Apps → KekeRide → **Auto-start** on.
3. i Manager → App manager → Autostart manager → enable KekeRide.
