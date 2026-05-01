import 'package:flutter_foreground_task/flutter_foreground_task.dart';

// Entry point for the foreground task — must be top-level and annotated.
@pragma('vm:entry-point')
void locationTaskCallback() {
  FlutterForegroundTask.setTaskHandler(_KeepAliveTaskHandler());
}

// Minimal handler — its only job is to keep the Android process alive
// so the main-isolate Timer + Geolocator heartbeat keep firing normally.
class _KeepAliveTaskHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp) async {}
}

void initForegroundTask() {
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'keke_driver_location',
      channelName: 'Location Service',
      channelDescription: 'Keeps your location active while you are online for rides',
      onlyAlertOnce: true,
      playSound: false,
    ),
    iosNotificationOptions: const IOSNotificationOptions(
      showNotification: false,
      playSound: false,
    ),
    foregroundTaskOptions: ForegroundTaskOptions(
      eventAction: ForegroundTaskEventAction.nothing(),
      autoRunOnBoot: false,
      allowWifiLock: false,
    ),
  );
}
