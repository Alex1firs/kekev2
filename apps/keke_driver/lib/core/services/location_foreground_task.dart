import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:dio/dio.dart';

// Keys used to hand the heartbeat context from the main isolate (where auth
// lives) to the foreground-service isolate (which has no access to Riverpod).
// Written via FlutterForegroundTask.saveData before startService().
const String kHbUrlKey = 'hb_url';
const String kHbTokenKey = 'hb_token';
const String kHbUserKey = 'hb_user';

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
    await _beat();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    // onRepeatEvent is synchronous; fire-and-forget the async beat.
    _beat();
  }

  @override
  Future<void> onDestroy(DateTime timestamp) async {}

  Future<void> _beat() async {
    try {
      final url = await FlutterForegroundTask.getData<String>(key: kHbUrlKey);
      final token = await FlutterForegroundTask.getData<String>(key: kHbTokenKey);
      final userId = await FlutterForegroundTask.getData<String>(key: kHbUserKey);
      if (url == null || token == null || userId == null) return;

      Position? pos;
      try {
        // Low accuracy resolves quickly from cell/WiFi and avoids GPS cold-start
        // timeouts that would silently drop a beat.
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.low,
          timeLimit: const Duration(seconds: 8),
        );
      } catch (_) {
        pos = await Geolocator.getLastKnownPosition();
      }
      if (pos == null) return;

      await _dio.post(
        '$url/drivers/heartbeat',
        data: {'driverId': userId, 'lat': pos.latitude, 'lng': pos.longitude},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
    } catch (_) {
      // Never throw from the service isolate — just miss this beat and retry
      // on the next interval.
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
