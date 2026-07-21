import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../services/reliability_log.dart';

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
  await Firebase.initializeApp();
  ReliabilityLog.log(RelEvent.fcmReceived, {
    'state': 'background',
    'type': message.data['type'],
    'rideId': message.data['rideId'],
    'hasNotification': message.notification != null,
  });
}

class NotificationService {
  final Dio? _dio;
  final String _role;
  final _intentStreamController = StreamController<Map<String, dynamic>>.broadcast();

  NotificationService(this._dio, this._role);

  Stream<Map<String, dynamic>> get intentStream => _intentStreamController.stream;

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
