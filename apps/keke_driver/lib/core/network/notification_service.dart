import 'dart:async';
import 'dart:ui' show DartPluginRegistrant;
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import '../services/reliability_log.dart';
import '../services/ride_notification_service.dart';
import '../services/location_foreground_task.dart'
    show kHbUrlKey, kHbTokenKey, startLocationHeartbeatService;

/// Background message handler.
///
/// MUST be a top-level (or static) function annotated with `vm:entry-point`
/// because firebase_messaging runs it in a separate isolate. Firebase has to be
/// re-initialised inside this isolate. For notification-type messages iOS/Android
/// auto-display the alert on the lock screen (via the high-importance
/// `keke_ride_requests` channel), so this handler must NOT display a second
/// notification — it only records receipt for diagnostics. Data-only payloads
/// are still processed here when the app is backgrounded or terminated.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  /*
   * ── Register platform plugins in THIS isolate, first ─────────────────
   *
   * FCM runs this in a brand-new Dart isolate that has never executed
   * main(), so the plugin registry is empty. firebase_core registers
   * itself, which is why Firebase.initializeApp() below works — but every
   * OTHER plugin throws MissingPluginException on first use.
   *
   * That is exactly how the first field test failed: FCM accepted the wake
   * and delivered it, this handler ran, and then FlutterForegroundTask
   * .getData() and Geolocator both threw. The catch swallowed it into a
   * wake_failed nobody could see from the server, so the driver looked like
   * a phone that had simply ignored the push.
   */
  DartPluginRegistrant.ensureInitialized();
  await Firebase.initializeApp();
  final type = message.data['type'];
  ReliabilityLog.log(RelEvent.fcmReceived, {
    'state': 'background',
    'type': type,
    'rideId': message.data['rideId'],
    'hasNotification': message.notification != null,
  });

  // A PRESENCE_WAKE is the server saying "we cannot see your phone and a
  // passenger needs you". It is data-only and invisible on purpose: the
  // driver should never see it, they should just start getting offers again.
  if (type == 'PRESENCE_WAKE') {
    await answerPresenceWake(rideId: message.data['rideId']?.toString());
  }
}

/// Answer a wake-up push: take a fresh fix and post it as a heartbeat.
///
/// ── Why this is enough ──────────────────────────────────────────────────
/// The driver's ONLINE intent already lives on the server and never lapsed.
/// The only thing missing was a current position, so that is the only thing
/// this has to supply. One successful beat puts the driver back in the normal
/// dispatch pool, and the ride offer follows moments later on the same
/// connection — with no toggle, no tap and no app reopen.
///
/// Runs in the FCM background isolate, which has no Riverpod and no auth
/// state, so the credentials come from the same cross-isolate store the
/// Android foreground service already populates.
@pragma('vm:entry-point')
Future<void> answerPresenceWake({String? rideId}) async {
  ReliabilityLog.log(RelEvent.wakeReceived, {'rideId': rideId});
  try {
    final url = await FlutterForegroundTask.getData<String>(key: kHbUrlKey);
    final token = await FlutterForegroundTask.getData<String>(key: kHbTokenKey);
    if (url == null || token == null || url.isEmpty || token.isEmpty) {
      // No stored credentials means the driver is not signed in on this
      // device. Nothing to answer with, and nothing is wrong.
      ReliabilityLog.log(RelEvent.wakeFailed, {'reason': 'no_context'});
      return;
    }

    // A last-known fix is accepted first so a woken phone answers in about a
    // second rather than waiting on a cold GPS lock, which on a keke under a
    // roof can take 30s or never. Accuracy is refined by the beats that follow.
    Position? pos;
    try {
      pos = await Geolocator.getLastKnownPosition();
    } catch (_) {/* fall through to a live fix */}

    final fresh = pos == null ||
        DateTime.now().difference(pos.timestamp).inMinutes >= 2;
    if (fresh) {
      try {
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.medium,
          timeLimit: const Duration(seconds: 8),
        );
      } catch (_) {
        // Keep whatever last-known fix we had; a slightly old position that
        // reaches the server beats no answer at all.
      }
    }

    if (pos == null) {
      ReliabilityLog.log(RelEvent.wakeFailed, {'reason': 'no_location'});
      return;
    }

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 8),
      receiveTimeout: const Duration(seconds: 8),
    ));
    await dio.post(
      '\$url/drivers/heartbeat',
      data: {'lat': pos.latitude, 'lng': pos.longitude},
      options: Options(headers: {'Authorization': 'Bearer \$token'}),
    );

    ReliabilityLog.log(RelEvent.wakeAnswered, {'rideId': rideId});

    /*
     * ── Post the alert ourselves, now that we are running ───────────────
     *
     * Reaching this line means Android let our process start, which is the
     * hard part on an aggressive OEM. Use it: a full-screen-intent
     * notification wakes the screen and rings over the lock screen, and it
     * is the ONE presentation MIUI honours without the driver having enabled
     * "Floating notifications" and lock-screen visibility per channel — both
     * of which ship OFF on Redmi and were OFF on the field-test handset.
     *
     * The alert the server sent alongside this wake sits quietly in the tray
     * on such a phone. This is what actually gets the driver's attention.
     */
    if (rideId != null && rideId.isNotEmpty) {
      try {
        await RideNotificationService.instance.showRideRequest(
          rideId: rideId,
          title: 'Ride request nearby',
          body: 'A passenger near you needs a Keke. Tap to take the trip.',
        );
      } catch (e) {
        // An alert we could not draw must never lose us the heartbeat above.
        ReliabilityLog.log(RelEvent.wakeFailed,
            {'reason': 'alert_failed', 'detail': e.runtimeType.toString()});
      }
    }

    // ── Stay awake, rather than needing a knock per ride ────────────────
    //
    // Answering once proves the phone is alive but does nothing to keep it
    // that way: if an OEM battery manager killed the foreground service, the
    // driver goes stale again within the minute and every subsequent offer
    // pays the wake round-trip. Restarting the service here is what turns one
    // wake into a working shift.
    //
    // Android only, and best-effort. A high-priority FCM message grants a
    // short window in which a background app may start a foreground service;
    // outside that window Android 12+ refuses, which is a refusal to log
    // rather than an error to surface. iOS has no equivalent and does not
    // need one — it answers each wake individually.
    if (Platform.isAndroid) {
      try {
        if (!await FlutterForegroundTask.isRunningService) {
          await startLocationHeartbeatService();
          ReliabilityLog.log(RelEvent.fgsStarted, {'starter': 'wake'});
        }
      } catch (e) {
        ReliabilityLog.log(RelEvent.wakeFailed,
            {'reason': 'fgs_restart_denied', 'detail': e.runtimeType.toString()});
      }
    }
  } catch (e) {
    // Never rethrow from a background isolate: an unhandled error here is a
    // crash the driver would see as the app dying in their pocket.
    ReliabilityLog.log(RelEvent.wakeFailed, {'reason': e.runtimeType.toString()});
  }
}

class NotificationService {
  final Dio? _dio;
  final String _role;
  final _intentStreamController = StreamController<Map<String, dynamic>>.broadcast();

  NotificationService(this._dio, this._role);

  Stream<Map<String, dynamic>> get intentStream => _intentStreamController.stream;

  /// Test seam: push a notification payload as if the OS had delivered it.
  /// Firebase is unavailable under `flutter test`, so the tap path cannot
  /// otherwise be exercised.
  @visibleForTesting
  void injectIntent(Map<String, dynamic> data) => _intentStreamController.add(data);

  Future<void> initialize() async {
    try {
      await Firebase.initializeApp();

      final messaging = FirebaseMessaging.instance;

      // 1. Request OS permission (shows the native iOS prompt on first launch).
      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      print('[PUSH] Permission status: ${settings.authorizationStatus}');
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        print('[PUSH] Notifications DENIED — the user must enable them in '
            'Settings > Keke Driver > Notifications for ride pushes to work.');
      }

      // 2. Show notifications while the app is in the FOREGROUND too (iOS needs this
      //    explicitly, otherwise foreground pushes are silently suppressed).
      await messaging.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );

      // 3. Register the background/terminated handler (top-level function above).
      FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

      // 4. Foreground + tap listeners.
      FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        // Foreground: the in-app socket path shows the ride card + ring, so we
        // do NOT display a notification here (avoids a duplicate alert).
        ReliabilityLog.log(RelEvent.fcmReceived, {
          'state': 'foreground',
          'type': message.data['type'],
          'rideId': message.data['rideId'],
        });
        // A wake can arrive while the app is alive — the server cannot know
        // what state the phone is in. Answering is cheap, and it re-freshes
        // the availability key even if the heartbeat timer has been throttled.
        if (message.data['type'] == 'PRESENCE_WAKE') {
          unawaited(answerPresenceWake(rideId: message.data['rideId']?.toString()));
        }
      });
      FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
        print('[PUSH] Notification tapped (from background): ${message.data}');
        _intentStreamController.add(message.data);
      });

      // 5. Re-register with the backend whenever FCM rotates the token.
      FirebaseMessaging.instance.onTokenRefresh.listen((newToken) {
        print('[PUSH] Token refreshed — re-registering with backend...');
        registerDeviceToken();
      });
    } catch (e) {
      print('[PUSH_ERROR] Initialization failed: $e');
    }
  }

  Future<void> handleInitialMessage() async {
    final initialMessage = await FirebaseMessaging.instance.getInitialMessage();
    if (initialMessage != null) {
      print('[PUSH] Launched from terminated via notification: ${initialMessage.data}');
      _intentStreamController.add(initialMessage.data);
    }
  }

  /// iOS-only: the FCM token is only issued AFTER APNs hands the app a device
  /// token. On a cold first launch that can lag a few seconds, so poll briefly.
  /// Returns the APNs token, or null if it never arrives (which means push is
  /// mis-configured — missing aps-environment entitlement / Push capability on
  /// the App ID / APNs key not uploaded to Firebase).
  Future<String?> _waitForApnsToken() async {
    const maxAttempts = 6;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      final apns = await FirebaseMessaging.instance.getAPNSToken();
      if (apns != null) {
        print('[PUSH] APNs token available (attempt $attempt/$maxAttempts).');
        return apns;
      }
      print('[PUSH] APNs token not ready (attempt $attempt/$maxAttempts) — waiting 2s...');
      await Future.delayed(const Duration(seconds: 2));
    }
    print('[PUSH] APNs token MISSING after $maxAttempts attempts. '
        'iOS push will NOT work — verify aps-environment entitlement, Push '
        'Notifications on App ID ng.kekeride.driver, and the APNs key in Firebase.');
    return null;
  }

  /// Fetch the FCM token. On iOS this waits for the APNs token first, otherwise
  /// getToken() returns null on a cold launch.
  Future<String?> getToken() async {
    try {
      if (Platform.isIOS) {
        final apns = await _waitForApnsToken();
        if (apns == null) return null; // no APNs => FCM token is unusable
      }
      final fcm = await FirebaseMessaging.instance.getToken();
      if (fcm == null) {
        print('[PUSH] FCM token is NULL.');
      } else {
        print('[PUSH] FCM token generated: ${fcm.substring(0, 12)}…');
      }
      return fcm;
    } catch (e) {
      print('[PUSH_ERROR] Failed to get token: $e');
      return null;
    }
  }

  /// Register this device's FCM token with the backend. Only sends when a real
  /// FCM token exists. On iOS a cold launch may not have the APNs token ready on
  /// the first try, so this retries with backoff (up to 4 attempts).
  Future<void> registerDeviceToken({int attempt = 1}) async {
    if (_dio == null) return;

    final token = await getToken();
    if (token == null) {
      const maxAttempts = 4;
      if (attempt < maxAttempts) {
        final delay = Duration(seconds: 3 * attempt);
        print('[PUSH] No FCM token yet — retrying registration in '
            '${delay.inSeconds}s (attempt $attempt/$maxAttempts).');
        Future.delayed(delay, () => registerDeviceToken(attempt: attempt + 1));
      } else {
        print('[PUSH] Gave up registering device token after $attempt attempts '
            '(no FCM token — likely an iOS APNs/entitlement problem).');
      }
      return;
    }

    final platform = Platform.isIOS ? 'ios' : 'android';
    try {
      print('[PUSH] Registering $platform token with backend...');
      await _dio!.post('/notifications/tokens', data: {
        'token': token,
        'platform': platform,
        'role': _role,
        'deviceLabel': Platform.localHostname,
      });
      print('[PUSH] Device token registration SUCCESS ($platform).');
    } catch (e) {
      print('[PUSH_ERROR] Failed to register token: $e');
    }
  }

  Future<void> deleteToken(String token) async {
    if (_dio == null) return;
    try {
      await _dio!.delete('/notifications/tokens/$token');
      print('[PUSH] Token deactivated on logout.');
    } catch (e) {
      print('[PUSH_ERROR] Failed to deactivate token: $e');
    }
  }
}
