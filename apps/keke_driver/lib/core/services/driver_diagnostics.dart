import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'battery_optimization_service.dart';
import 'location_foreground_task.dart';
import 'oem_battery_service.dart';

/// A point-in-time snapshot of everything that determines whether a driver is
/// actually operationally online and dispatch-eligible. Rendered by the
/// Diagnostics screen and used to explain WHY a driver is/ isn't reaching
/// passengers — without needing a computer or the backend.
class DriverDiagnostics {
  final bool onlineIntent;
  final bool serviceRunning;
  final DateTime? lastHeartbeatAt;
  final int? heartbeatAgeSeconds;
  final DateTime? lastLocationAt;
  final int? locationAgeSeconds;
  final String? lastHeartbeatError;
  final bool batteryOptimized; // true = still optimized (bad)
  final bool aggressiveOem;
  final String oemName;
  final LocationPermission locationPermission;
  final bool backgroundLocationGranted;
  final bool locationServiceEnabled;
  final bool notificationsGranted;
  final bool fcmTokenPresent;
  final bool online; // network reachable
  final String networkType;
  final String appVersion;
  final int androidSdk;

  const DriverDiagnostics({
    required this.onlineIntent,
    required this.serviceRunning,
    required this.lastHeartbeatAt,
    required this.heartbeatAgeSeconds,
    required this.lastLocationAt,
    required this.locationAgeSeconds,
    required this.lastHeartbeatError,
    required this.batteryOptimized,
    required this.aggressiveOem,
    required this.oemName,
    required this.locationPermission,
    required this.backgroundLocationGranted,
    required this.locationServiceEnabled,
    required this.notificationsGranted,
    required this.fcmTokenPresent,
    required this.online,
    required this.networkType,
    required this.appVersion,
    required this.androidSdk,
  });

  /// Heartbeat is fresh if a successful beat landed within the backend's 45s
  /// availability window.
  bool get heartbeatFresh => heartbeatAgeSeconds != null && heartbeatAgeSeconds! <= 45;

  /// Location is fresh enough for dispatch if updated within ~90s.
  bool get locationFresh => locationAgeSeconds != null && locationAgeSeconds! <= 90;

  /// Client-side estimate of dispatch eligibility. The backend is authoritative,
  /// but this mirrors its inputs so the driver sees the same verdict.
  bool get dispatchEligible =>
      onlineIntent &&
      serviceRunning &&
      heartbeatFresh &&
      locationFresh &&
      online &&
      backgroundLocationGranted;

  /// The single most-important reason the driver is NOT eligible (or null).
  String? get blockingReason {
    if (!onlineIntent) return 'You are Offline — toggle Online to receive rides.';
    if (!locationServiceEnabled) return 'Location (GPS) is turned off on the phone.';
    if (locationPermission == LocationPermission.denied ||
        locationPermission == LocationPermission.deniedForever) {
      return 'Location permission is not granted.';
    }
    if (!backgroundLocationGranted) {
      return 'Background location is not set to "Allow all the time".';
    }
    if (!online) return 'No internet connection.';
    if (!serviceRunning) return 'Background service is not running.';
    if (!heartbeatFresh) return 'Heartbeat is stale — the server may not see you online.';
    if (!locationFresh) return 'Location is stale.';
    if (batteryOptimized && aggressiveOem) {
      return 'Battery restriction may stop KekeRide in the background.';
    }
    return null;
  }

  static Future<DriverDiagnostics> collect({required bool onlineIntent}) async {
    final now = DateTime.now();

    bool serviceRunning = false;
    try {
      serviceRunning = await FlutterForegroundTask.isRunningService;
    } catch (_) {}

    DateTime? lastHb;
    int? hbAge;
    DateTime? lastLoc;
    int? locAge;
    String? lastErr;
    try {
      final okStr = await FlutterForegroundTask.getData<String>(key: kHbLastOkAtKey);
      if (okStr != null && okStr.isNotEmpty) {
        lastHb = DateTime.fromMillisecondsSinceEpoch(int.parse(okStr));
        hbAge = now.difference(lastHb).inSeconds;
      }
      final locStr = await FlutterForegroundTask.getData<String>(key: kHbLastLocAtKey);
      if (locStr != null && locStr.isNotEmpty) {
        lastLoc = DateTime.fromMillisecondsSinceEpoch(int.parse(locStr));
        locAge = now.difference(lastLoc).inSeconds;
      }
      final e = await FlutterForegroundTask.getData<String>(key: kHbLastErrorKey);
      lastErr = (e == null || e.isEmpty) ? null : e;
    } catch (_) {}

    final batteryOptimized = await BatteryOptimizationService.isOptimizationActive();
    final aggressive = await OemBatteryService.isAggressiveOem();
    final oem = (await OemBatteryService.guidance()).manufacturer;
    final sdk = await OemBatteryService.androidSdk();

    LocationPermission perm = LocationPermission.denied;
    bool locEnabled = false;
    try {
      perm = await Geolocator.checkPermission();
      locEnabled = await Geolocator.isLocationServiceEnabled();
    } catch (_) {}
    final bgGranted = perm == LocationPermission.always;

    bool notif = false;
    try {
      notif = (await FlutterForegroundTask.checkNotificationPermission()) ==
          NotificationPermission.granted;
    } catch (_) {}

    bool fcmToken = false;
    try {
      fcmToken = (await FirebaseMessaging.instance.getToken()) != null;
    } catch (_) {}

    bool online = false;
    String netType = 'none';
    try {
      final conn = await Connectivity().checkConnectivity();
      // connectivity_plus v6 returns List<ConnectivityResult>.
      final results = <ConnectivityResult>[...conn];
      online = results.any((r) => r != ConnectivityResult.none);
      netType = results.map((r) => r.name).join(',');
    } catch (_) {}

    String version = 'unknown';
    try {
      final info = await PackageInfo.fromPlatform();
      version = '${info.version}+${info.buildNumber}';
    } catch (_) {}

    return DriverDiagnostics(
      onlineIntent: onlineIntent,
      serviceRunning: serviceRunning,
      lastHeartbeatAt: lastHb,
      heartbeatAgeSeconds: hbAge,
      lastLocationAt: lastLoc,
      locationAgeSeconds: locAge,
      lastHeartbeatError: lastErr,
      batteryOptimized: batteryOptimized,
      aggressiveOem: aggressive,
      oemName: oem,
      locationPermission: perm,
      backgroundLocationGranted: bgGranted,
      locationServiceEnabled: locEnabled,
      notificationsGranted: notif,
      fcmTokenPresent: fcmToken,
      online: online,
      networkType: netType,
      appVersion: version,
      androidSdk: sdk,
    );
  }
}
