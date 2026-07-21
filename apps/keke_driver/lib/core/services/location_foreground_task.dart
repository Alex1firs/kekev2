import 'dart:io';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:dio/dio.dart';
import 'reliability_log.dart';

// Keys used to hand the heartbeat context from the main isolate (where auth
// lives) to the foreground-service isolate (which has no access to Riverpod).
// Written via FlutterForegroundTask.saveData before startService().
const String kHbUrlKey = 'hb_url';
const String kHbTokenKey = 'hb_token';
const String kHbUserKey = 'hb_user';
const String kHbAppVersionKey = 'hb_app_version';
// Shared keys the service isolate WRITES so the UI isolate can read freshness
// for the diagnostics screen (saveData persists across isolates).
const String kHbLastOkAtKey = 'hb_last_ok_at';       // epoch ms of last 2xx beat
const String kHbLastLocAtKey = 'hb_last_loc_at';     // epoch ms of last usable fix
const String kHbLastErrorKey = 'hb_last_error';      // last failure reason

// Entry point for the foreground task — must be top-level and annotated.
@pragma('vm:entry-point')
void locationTaskCallback() {
  FlutterForegroundTask.setTaskHandler(_HeartbeatTaskHandler());
}

/// Runs INSIDE the Android foreground-service isolate. Because the service holds
/// a wake lock and is exempt from app-standby, `onRepeatEvent` keeps firing on a
/// fixed interval even while the screen is locked or the app UI is suspended —
/// unlike a main-isolate `Timer`, which Doze throttles. Each tick posts the
/// driver's location to the backend HTTP heartbeat so they stay in the Redis
/// dispatch pool (45s availability TTL) and keep receiving ride pushes.
class _HeartbeatTaskHandler extends TaskHandler {
  final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 8),
    receiveTimeout: const Duration(seconds: 8),
  ));

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    ReliabilityLog.log(RelEvent.fgsStarted, {'starter': starter.name});
    await _beat();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    // onRepeatEvent is synchronous; fire-and-forget the async beat.
    _beat();
  }

  @override
  Future<void> onDestroy(DateTime timestamp) async {
    ReliabilityLog.log(RelEvent.fgsStopped, {'isolate': 'service'});
  }

  Future<void> _beat() async {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    try {
      final url = await FlutterForegroundTask.getData<String>(key: kHbUrlKey);
      final token = await FlutterForegroundTask.getData<String>(key: kHbTokenKey);
      final userId = await FlutterForegroundTask.getData<String>(key: kHbUserKey);
      final appVersion =
          await FlutterForegroundTask.getData<String>(key: kHbAppVersionKey) ?? 'unknown';
      if (url == null || token == null || userId == null) {
        ReliabilityLog.log(RelEvent.heartbeatFailed, {'reason': 'missing_context'});
        await FlutterForegroundTask.saveData(key: kHbLastErrorKey, value: 'missing_context');
        return;
      }

      Position? pos;
      String locSource = 'current';
      try {
        // Low accuracy resolves quickly from cell/WiFi and avoids GPS cold-start
        // timeouts that would silently drop a beat.
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.low,
          timeLimit: const Duration(seconds: 8),
        );
      } catch (_) {
        pos = await Geolocator.getLastKnownPosition();
        locSource = 'last_known';
      }
      if (pos == null) {
        ReliabilityLog.log(RelEvent.locationFailed, {'reason': 'no_fix'});
        await FlutterForegroundTask.saveData(key: kHbLastErrorKey, value: 'no_location');
        return;
      }
      // Reject an obviously unusable/old last-known fix (>5 min) — better to miss
      // a beat than report a stale position as fresh.
      final fixAgeMs = nowMs - pos.timestamp.millisecondsSinceEpoch;
      if (locSource == 'last_known' && fixAgeMs > 5 * 60 * 1000) {
        ReliabilityLog.log(RelEvent.locationFailed, {'reason': 'stale_last_known', 'ageMs': fixAgeMs});
        await FlutterForegroundTask.saveData(key: kHbLastErrorKey, value: 'stale_location');
        return;
      }
      await FlutterForegroundTask.saveData(key: kHbLastLocAtKey, value: nowMs.toString());
      ReliabilityLog.log(RelEvent.locationObtained,
          {'source': locSource, 'acc': pos.accuracy.round(), 'lat': pos.latitude, 'lng': pos.longitude});

      final res = await _dio.post(
        '$url/drivers/heartbeat',
        // Richer payload: server ignores unknown fields today, but these make the
        // heartbeat self-describing for diagnostics + future server-side use.
        data: {
          'driverId': userId,
          'lat': pos.latitude,
          'lng': pos.longitude,
          'accuracy': pos.accuracy,
          'speed': pos.speed,
          'heading': pos.heading,
          'locationTimestamp': pos.timestamp.toIso8601String(),
          'sentAt': DateTime.now().toIso8601String(),
          'source': 'foreground_service',
          'appVersion': appVersion,
          'platform': Platform.isAndroid ? 'android' : 'ios',
        },
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      await FlutterForegroundTask.saveData(key: kHbLastOkAtKey, value: nowMs.toString());
      await FlutterForegroundTask.saveData(key: kHbLastErrorKey, value: '');
      ReliabilityLog.log(RelEvent.heartbeatSent,
          {'status': res.statusCode, 'src': locSource});
    } catch (e) {
      // Never throw from the service isolate — just miss this beat and retry
      // on the next interval.
      ReliabilityLog.log(RelEvent.heartbeatFailed, {'error': e.toString()});
      try {
        await FlutterForegroundTask.saveData(key: kHbLastErrorKey, value: e.toString());
      } catch (_) {}
    }
  }
}

void initForegroundTask() {
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'keke_driver_location',
      channelName: 'Online status',
      channelDescription: 'Keeps you online and receiving ride requests.',
      onlyAlertOnce: true,
      playSound: false,
    ),
    iosNotificationOptions: const IOSNotificationOptions(
      showNotification: false,
      playSound: false,
    ),
    foregroundTaskOptions: ForegroundTaskOptions(
      // Fire the heartbeat inside the service isolate every 12s (matches the
      // 45s backend availability TTL — 3 missed beats tolerated).
      eventAction: ForegroundTaskEventAction.repeat(12000),
      autoRunOnBoot: false,
      // Hold a partial wake lock so the CPU stays awake enough to run the
      // interval + network call while the screen is locked.
      allowWakeLock: true,
      allowWifiLock: true,
    ),
  );
}
