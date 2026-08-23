import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../../features/passenger/domain/booking_state.dart';

/// The persistent "you have a ride" entry in the Android status bar.
///
/// ── Why an ongoing notification and not a foreground service ─────────────
/// A foreground service exists to keep a process ALIVE for background work.
/// The passenger app has no background work: it does not track location, does
/// not hold a socket while closed, and does not need to run. Demanding a
/// foreground service for a status line would cost a permanent, undismissable
/// notification and, on Android 14+, a `foregroundServiceType` we could not
/// honestly justify.
///
/// An ordinary notification with `ongoing: true` gives what is actually needed:
///
///  - it **survives process death**. Android owns the posted notification, not
///    the app, so force-closing KekeRide leaves it in the tray, still tappable.
///    That is the entire point — the passenger who swipes the app away is
///    exactly the one who needs it.
///  - the passenger cannot swipe it away by accident while a ride is live.
///  - it costs no permission beyond POST_NOTIFICATIONS, already declared.
///
/// ── What it cannot do ────────────────────────────────────────────────────
/// It cannot update itself while the process is dead. If the driver arrives
/// while the app is closed, this text stays on the previous state until either
/// an FCM lifecycle push arrives (those already exist and are handled in the
/// background isolate) or the passenger opens the app, at which point
/// server-authoritative recovery corrects it. The notification is a
/// convenience and a way back in — never a source of truth.
///
/// ── Importance is deliberately low ───────────────────────────────────────
/// `Importance.low` means no sound, no vibration, no heads-up. This is a status
/// line, not an alert. The alerts are the backend's ride pushes on
/// `keke_ride_updates`; making this one loud would mean the passenger is buzzed
/// twice for every state change.
class RideStatusNotification {
  RideStatusNotification._();
  static final RideStatusNotification instance = RideStatusNotification._();

  static const String channelId = 'keke_ride_status';
  static const String channelName = 'Active ride';

  /// Fixed id: posting again with the same id UPDATES the existing entry rather
  /// than stacking a second one. A passenger must never see two live rides.
  static const int notificationId = 8001;

  @visibleForTesting
  static const String tapPayload = 'active_ride';

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _initialized = false;

  /// What is currently on screen, so an unchanged state is not re-posted.
  String? _shownKey;

  /// Overridable in tests, which have no platform channels.
  @visibleForTesting
  static bool Function() platformSupported = () => Platform.isAndroid;

  Future<void> initialize({
    void Function(String? payload)? onTap,
  }) async {
    if (_initialized) return;
    if (!platformSupported()) return;
    try {
      const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
      await _plugin.initialize(
        const InitializationSettings(android: androidInit),
        onDidReceiveNotificationResponse: (response) => onTap?.call(response.payload),
      );

      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await android?.createNotificationChannel(const AndroidNotificationChannel(
        channelId,
        channelName,
        description: 'Shows your ride while it is in progress',
        // See the note above: a status line, not an alert.
        importance: Importance.low,
        playSound: false,
        enableVibration: false,
      ));
      _initialized = true;
    } catch (e) {
      // A notification is a convenience. Failing to create the channel must
      // never stop the app from working.
      debugPrint('[RIDE_NOTIFICATION] init failed: $e');
    }
  }

  /// The copy for a ride state, or null if this state should show nothing.
  ///
  /// Pure and public so the wording is testable without a platform channel —
  /// the text is the part a passenger actually reads.
  static ({String title, String body})? copyFor(
    BookingStep step, {
    String? driverName,
    String? destination,
  }) {
    final who = (driverName != null && driverName.trim().isNotEmpty)
        ? driverName.trim()
        : 'Your driver';
    final to = (destination != null && destination.trim().isNotEmpty)
        ? destination.trim()
        : null;

    switch (step) {
      case BookingStep.searching:
        return (
          title: 'Finding you a Keke',
          body: to == null ? 'Looking for a driver nearby.' : 'Looking for a driver to $to.',
        );
      case BookingStep.offerSent:
        // A driver is deciding. Deliberately not "your driver" — nobody has
        // accepted, and they may still decline.
        return (
          title: 'Driver found',
          body: 'Waiting for the driver to confirm your trip.',
        );
      case BookingStep.confirmed:
        return (
          title: '$who is on the way',
          body: to == null ? 'Tap to track your ride.' : 'Heading to you — trip to $to.',
        );
      case BookingStep.arrived:
        return (
          title: '$who has arrived',
          body: 'Your Keke is at the pickup point.',
        );
      case BookingStep.started:
        return (
          title: 'Trip in progress',
          body: to == null ? 'Tap to view your trip.' : 'On the way to $to.',
        );
      // Everything else is either pre-booking or terminal. A receipt is not a
      // live ride, so `completed` shows nothing and the entry is cleared.
      case BookingStep.loading:
      case BookingStep.idle:
      case BookingStep.selectingPickup:
      case BookingStep.selectingDestination:
      case BookingStep.selectingDestinationOnMap:
      case BookingStep.previewEstimate:
      case BookingStep.completed:
        return null;
    }
  }

  /// Post or update the entry for the current ride state.
  ///
  /// Idempotent: an unchanged state is not re-posted, so a socket burst does not
  /// make the notification flicker or re-announce itself.
  Future<void> show(
    BookingStep step, {
    String? driverName,
    String? destination,
  }) async {
    if (!platformSupported()) return;

    final copy = copyFor(step, driverName: driverName, destination: destination);
    if (copy == null) {
      await clear();
      return;
    }

    final key = '${copy.title}|${copy.body}';
    if (key == _shownKey) return;

    await initialize();
    if (!_initialized) return;

    try {
      await _plugin.show(
        notificationId,
        copy.title,
        copy.body,
        const NotificationDetails(
          android: AndroidNotificationDetails(
            channelId,
            channelName,
            importance: Importance.low,
            priority: Priority.low,
            // Not swipe-away-able while the ride is live, and not auto-cancelled
            // when tapped — the ride is still going after the passenger looks.
            ongoing: true,
            autoCancel: false,
            // No timestamp: a "when" on a status line reads as the time
            // something happened, and this is a standing state.
            showWhen: false,
            onlyAlertOnce: true,
            category: AndroidNotificationCategory.transport,
          ),
        ),
        payload: tapPayload,
      );
      _shownKey = key;
    } catch (e) {
      debugPrint('[RIDE_NOTIFICATION] show failed: $e');
    }
  }

  /// Remove the entry. Idempotent — safe to call when nothing is showing, which
  /// is what makes it safe to call from every terminal path.
  Future<void> clear() async {
    _shownKey = null;
    if (!platformSupported() || !_initialized) return;
    try {
      await _plugin.cancel(notificationId);
    } catch (e) {
      debugPrint('[RIDE_NOTIFICATION] clear failed: $e');
    }
  }

  @visibleForTesting
  String? get debugShownKey => _shownKey;

  @visibleForTesting
  void debugReset() {
    _shownKey = null;
    _initialized = false;
  }
}
