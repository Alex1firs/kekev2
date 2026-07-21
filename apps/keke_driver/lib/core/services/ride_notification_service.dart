import 'dart:io';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'reliability_log.dart';

/// Locked-screen ride-request alerts.
///
/// Two responsibilities:
///  1. Create the high-importance Android channel `keke_ride_requests` (matching
///     the backend `channelId` + the manifest default channel) with the custom
///     `keke_ring` sound and full-screen-intent capability. Channel importance
///     and sound are FIXED at creation time, so creating it correctly client-side
///     guarantees the backend's ride push renders as a loud heads-up that wakes
///     the lock screen — even on a fresh install.
///  2. Optionally display a full-screen ride notification the app controls
///     (used as a backup when the app surfaces an offer itself), de-duplicated
///     by rideId so a driver never gets two rings for one offer.
class RideNotificationService {
  RideNotificationService._();
  static final RideNotificationService instance = RideNotificationService._();

  static const String channelId = 'keke_ride_requests';
  static const String channelName = 'Ride Requests';
  static const int _rideNotificationId = 7001;

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _initialized = false;

  /// rideIds we've already rung for, so FCM + socket paths never double-alert.
  final Set<String> _shownRideIds = <String>{};

  Future<void> initialize() async {
    if (_initialized) return;
    try {
      const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
      const initSettings = InitializationSettings(android: androidInit);
      await _plugin.initialize(initSettings);

      if (Platform.isAndroid) {
        final android = _plugin.resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
        // High-importance channel with the custom ring sound. If a channel with
        // this id already exists with different settings, delete + recreate so
        // the loud sound/heads-up is guaranteed.
        await android?.deleteNotificationChannel(channelId);
        await android?.createNotificationChannel(const AndroidNotificationChannel(
          channelId,
          channelName,
          description: 'Incoming ride requests for online drivers',
          importance: Importance.max,
          playSound: true,
          sound: RawResourceAndroidNotificationSound('keke_ring'),
          enableVibration: true,
          enableLights: true,
        ));
      }
      _initialized = true;
      ReliabilityLog.log('ride_channel_ready', {'channel': channelId});
    } catch (e) {
      ReliabilityLog.log('ride_channel_error', {'error': e.toString()});
    }
  }

  bool alreadyShown(String rideId) => _shownRideIds.contains(rideId);

  /// Show a full-screen ride-request notification the app controls. Returns
  /// false (and logs) if this rideId was already surfaced.
  Future<bool> showRideRequest({
    required String rideId,
    required String title,
    required String body,
  }) async {
    if (!Platform.isAndroid) return false;
    if (_shownRideIds.contains(rideId)) {
      ReliabilityLog.log(RelEvent.rideNotificationDuplicateSuppressed, {'rideId': rideId});
      return false;
    }
    await initialize();
    try {
      final androidDetails = AndroidNotificationDetails(
        channelId,
        channelName,
        channelDescription: 'Incoming ride requests for online drivers',
        importance: Importance.max,
        priority: Priority.max,
        category: AndroidNotificationCategory.call,
        fullScreenIntent: true, // wake + show over the lock screen
        playSound: true,
        sound: const RawResourceAndroidNotificationSound('keke_ring'),
        ongoing: true,
        autoCancel: false,
        visibility: NotificationVisibility.public,
        ticker: 'New ride request',
      );
      await _plugin.show(
        _rideNotificationId,
        title,
        body,
        NotificationDetails(android: androidDetails),
        payload: rideId,
      );
      _shownRideIds.add(rideId);
      ReliabilityLog.log(RelEvent.rideNotificationShown, {'rideId': rideId});
      return true;
    } catch (e) {
      ReliabilityLog.log('ride_notification_error', {'rideId': rideId, 'error': e.toString()});
      return false;
    }
  }

  /// Clear the ride notification (on accept/reject/cancel/timeout).
  Future<void> clearRideRequest(String rideId) async {
    try {
      await _plugin.cancel(_rideNotificationId);
    } catch (_) {}
  }

  /// Forget a rideId so a genuinely new offer with the same id could ring again
  /// (defensive; ids are unique in practice).
  void forget(String rideId) => _shownRideIds.remove(rideId);
}
