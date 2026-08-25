import 'dart:async';
import 'dart:io';

import 'package:geolocator/geolocator.dart';

import 'reliability_log.dart';

/// Keeping an iOS driver reachable while they are working.
///
/// ── Why this is not the Android design ──────────────────────────────────
/// Android holds a foreground service and beats every 12 seconds. iOS has no
/// equivalent and will not give one: outside a few declared background modes,
/// Apple suspends the process and there is no supported way to prevent it.
/// Trying to keep Dart permanently alive on iOS is a losing fight and would be
/// rejected at review.
///
/// What Apple DOES permit, and what this uses, is a background location stream
/// under the `location` background mode. While the driver is ONLINE — actively
/// working, which is precisely the use case the mode exists for — Core Location
/// delivers updates and each one is a chance to beat. The blue status bar
/// indicator stays visible throughout, which is the honest signal to the driver
/// that we are using their location, and it stops the moment they go OFFLINE.
///
/// ── What this does NOT change ───────────────────────────────────────────
/// ONLINE intent is durable on the server and nothing here touches it. If iOS
/// suspends us anyway — low battery, the driver force-quits, Apple simply
/// decides to — the driver stays ONLINE and merely becomes STALE, recoverable
/// by the wake push exactly as on Android. This improves reachability; it is
/// not what defines it.
class IosPresenceService {
  IosPresenceService._();
  static final IosPresenceService instance = IosPresenceService._();

  StreamSubscription<Position>? _sub;
  bool get isRunning => _sub != null;

  /// Called with each background fix so the caller can beat.
  void Function(double lat, double lng)? onFix;

  /// Begin background location updates. Android is a no-op — it has the
  /// foreground service, and running both would double the battery cost.
  Future<void> start() async {
    if (!Platform.isIOS || _sub != null) return;

    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        ReliabilityLog.log('ios_presence_denied', {'permission': permission.name});
        return;
      }

      /*
       * `allowBackgroundLocationUpdates` is what actually keeps Core Location
       * running once the app leaves the foreground; without it the stream ends
       * at suspension and the driver goes quiet within a minute.
       *
       * `showBackgroundLocationIndicator` is deliberately true. Apple requires
       * the driver to be able to see that a backgrounded app is using their
       * location, and hiding it on a driver's personal phone would be wrong
       * even where it were permitted.
       *
       * `pauseLocationUpdatesAutomatically` is false: iOS pauses updates when
       * it decides the device is stationary, which for a parked driver waiting
       * at a junction is exactly when we still need to be reachable.
       */
      final settings = AppleSettings(
        accuracy: LocationAccuracy.medium,
        // Beat on movement rather than on a timer — a stationary driver is
        // kept fresh by the periodic timer instead, and this avoids burning
        // battery re-reporting the same corner.
        distanceFilter: 50,
        pauseLocationUpdatesAutomatically: false,
        showBackgroundLocationIndicator: true,
        allowBackgroundLocationUpdates: true,
        activityType: ActivityType.automotiveNavigation,
      );

      _sub = Geolocator.getPositionStream(locationSettings: settings).listen(
        (pos) => onFix?.call(pos.latitude, pos.longitude),
        onError: (e) => ReliabilityLog.log(
            'ios_presence_stream_error', {'error': e.runtimeType.toString()}),
        cancelOnError: false,
      );
      ReliabilityLog.log('ios_presence_started', {});
    } catch (e) {
      // Never let this stop a driver going online. Losing the stream costs
      // reachability, which the wake push recovers; throwing here would cost
      // them the shift.
      ReliabilityLog.log('ios_presence_failed', {'error': e.runtimeType.toString()});
    }
  }

  /// Stop background updates. Called when the driver goes OFFLINE or logs out.
  ///
  /// Leaving the stream running after a driver stops work would keep the blue
  /// indicator on their phone and keep draining battery for nothing.
  Future<void> stop() async {
    if (_sub == null) return;
    await _sub?.cancel();
    _sub = null;
    ReliabilityLog.log('ios_presence_stopped', {});
  }
}
