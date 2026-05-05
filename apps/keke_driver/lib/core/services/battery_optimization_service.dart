import 'dart:io';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class BatteryOptimizationService {
  static const _storage = FlutterSecureStorage();
  static const _promptShownKey = 'battery_opt_prompt_v1';

  /// True when Android battery optimization is still active for this app
  /// (i.e. we are NOT on the exemption list). Always false on iOS.
  static Future<bool> isOptimizationActive() async {
    if (!Platform.isAndroid) return false;
    try {
      final ignoring =
          await FlutterForegroundTask.isIgnoringBatteryOptimizations;
      return !ignoring;
    } catch (_) {
      return false;
    }
  }

  /// True after the driver has seen the first-time explanation sheet.
  static Future<bool> wasPromptShown() async {
    try {
      return await _storage.read(key: _promptShownKey) == 'true';
    } catch (_) {
      return false;
    }
  }

  static Future<void> markPromptShown() async {
    try {
      await _storage.write(key: _promptShownKey, value: 'true');
    } catch (_) {}
  }

  /// Opens the system dialog: "Allow [app] to ignore battery optimizations?"
  /// Requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in AndroidManifest.
  static Future<void> requestExemption() async {
    if (!Platform.isAndroid) return;
    try {
      await FlutterForegroundTask.requestIgnoreBatteryOptimization();
    } catch (_) {}
  }

  /// Opens the system battery optimization list (fallback for OEM devices
  /// like Xiaomi/Samsung that have their own power manager on top).
  static Future<void> openSettings() async {
    if (!Platform.isAndroid) return;
    try {
      await FlutterForegroundTask.openIgnoreBatteryOptimizationSettings();
    } catch (_) {}
  }
}
