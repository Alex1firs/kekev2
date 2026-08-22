import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:android_intent_plus/android_intent.dart';

import 'oem_battery_service.dart';
import 'reliability_log.dart';

/// How badly a missing setting hurts.
enum ReadinessSeverity {
  /// Trips will be missed. The driver must be told plainly.
  critical,

  /// Trips will usually arrive, but the alert may be quiet or delayed.
  degraded,
}

class ReadinessIssue {
  const ReadinessIssue({
    required this.id,
    required this.title,
    required this.detail,
    required this.actionLabel,
    required this.severity,
    required this.fix,
  });

  final String id;
  final String title;

  /// Written for a driver, not an engineer. No "foreground service", no "FCM".
  final String detail;
  final String actionLabel;
  final ReadinessSeverity severity;

  /// Opens the relevant system screen. Returns false if the OS refused.
  final Future<bool> Function() fix;
}

/// Whether this handset can actually deliver work to the driver.
///
/// ── Why this is not a settings checklist ────────────────────────────────
/// Most of what matters here cannot be read. Android exposes no API for
/// MIUI's Autostart toggle, none for a channel's "floating notification"
/// switch, and none for a manufacturer's private task-killer. An app that
/// only inspected what it can read would report everything healthy on a
/// Redmi that silently drops every trip — which is exactly what happened in
/// the field.
///
/// So the authority is the SERVER. It knows whether this phone has answered a
/// wake, and that is the only fact that actually matters: not "is a setting
/// on", but "did work reach this driver". Local checks are used where they
/// are reliable, and the manufacturer's own guidance fills the rest.
class DriverReadinessService {
  DriverReadinessService(this._dio);

  final Dio _dio;

  /// The server's view of this driver's reachability, or null if unknown.
  ///
  /// FRESH / STALE / UNREACHABLE / OFFLINE.
  String? lastServerReachability;
  int lastFailedWakes = 0;

  /// Ask the backend whether it can actually reach this phone.
  ///
  /// The one check that cannot lie: it reflects real delivery, not a toggle.
  Future<void> refreshServerView() async {
    try {
      final res = await _dio.get('/drivers/presence');
      final p = res.data is Map ? res.data['presence'] : null;
      if (p is Map) {
        lastServerReachability = p['reachability']?.toString();
        lastFailedWakes = (p['failedWakeCount'] as num?)?.toInt() ?? 0;
      }
    } catch (_) {
      // Offline or the endpoint is unavailable. Absence of evidence is not
      // evidence of a problem — leave the previous view alone.
    }
  }

  /// Everything currently standing between this driver and receiving trips.
  Future<List<ReadinessIssue>> check() async {
    final issues = <ReadinessIssue>[];
    if (!Platform.isAndroid) return issues;

    // ── 1. Notifications, which we CAN read ─────────────────────────────
    var notifGranted = true;
    try {
      notifGranted = await FlutterForegroundTask.checkNotificationPermission()
          == NotificationPermission.granted;
    } catch (_) {/* unknown, not broken */}
    if (!notifGranted) {
      issues.add(ReadinessIssue(
        id: 'notifications',
        title: 'Allow KekeRide notifications',
        detail: 'Without this your phone cannot alert you when a passenger '
            'requests a ride.',
        actionLabel: 'Allow',
        severity: ReadinessSeverity.critical,
        fix: () async {
          try {
            await FlutterForegroundTask.requestNotificationPermission();
          } catch (_) {
            await _openAppDetails();
          }
          return true;
        },
      ));
    }

    // ── 2. Battery optimisation, which we CAN read ──────────────────────
    var batteryOk = true;
    try {
      batteryOk = await FlutterForegroundTask.isIgnoringBatteryOptimizations;
    } catch (_) {/* treat as unknown, not broken */}
    if (!batteryOk) {
      issues.add(ReadinessIssue(
        id: 'battery',
        title: 'Stop Android from sleeping KekeRide',
        detail: 'Your phone is allowed to shut KekeRide down to save battery. '
            'When it does, ride requests stop arriving.',
        actionLabel: 'Fix this',
        severity: ReadinessSeverity.critical,
        fix: () async {
          await FlutterForegroundTask.requestIgnoreBatteryOptimization();
          return true;
        },
      ));
    }

    // ── 3. Autostart, which we CANNOT read ──────────────────────────────
    //
    // No API exposes it. Xiaomi, Oppo, Vivo and Transsion each keep it in
    // their own security app. So it is raised on the handsets that have it,
    // and the server's verdict below decides how loudly.
    final guidance = await OemBatteryService.guidance();
    if (guidance.aggressive) {
      final unreachable = lastServerReachability == 'UNREACHABLE';
      issues.add(ReadinessIssue(
        id: 'autostart',
        title: unreachable
            ? 'KekeRide cannot reach your phone'
            : 'Let KekeRide start on its own',
        detail: unreachable
            // The server has proof. Say so plainly rather than hedging.
            ? 'We have tried to send you ride requests and your phone did not '
                'respond. On ${guidance.os} phones, KekeRide must be allowed to '
                'start on its own or it cannot receive trips while closed.'
            : 'On ${guidance.os} phones, KekeRide must be allowed to start on '
                'its own. Without it you will stop receiving trips a few '
                'minutes after leaving the app.',
        actionLabel: 'Open settings',
        severity: ReadinessSeverity.critical,
        fix: () => OemBatteryService.openOemAutoStartSettings(),
      ));
    }

    // ── 4. How the alert is allowed to appear ───────────────────────────
    //
    // Whether a channel may show a floating banner or appear on the lock
    // screen is not readable either, and on MIUI both default to OFF. A
    // driver whose phone is face-down on the dashboard sees nothing at all,
    // so this is raised alongside autostart rather than treated as polish.
    if (guidance.aggressive) {
      issues.add(ReadinessIssue(
        id: 'alert_style',
        title: 'Let ride requests show on screen',
        detail: 'Turn on "Floating notifications" and allow notifications on '
            'the lock screen for Ride Requests, so you see and hear a trip '
            'without unlocking your phone.',
        actionLabel: 'Open notification settings',
        severity: ReadinessSeverity.degraded,
        fix: () async {
          await _openAppDetails();
          return true;
        },
      ));
    }

    ReliabilityLog.log('readiness_checked', {
      'issues': issues.map((i) => i.id).join(','),
      'serverReachability': lastServerReachability ?? 'unknown',
      'failedWakes': lastFailedWakes,
    });
    return issues;
  }

  /// Android's own per-app settings page, where notification behaviour and
  /// the lock-screen choice live on every OEM.
  static Future<void> _openAppDetails() async {
    try {
      await const AndroidIntent(
        action: 'android.settings.APPLICATION_DETAILS_SETTINGS',
        data: 'package:ng.kekeride.driver',
      ).launch();
    } catch (_) {/* nothing else to try */}
  }

  /// True when something will actively cost the driver trips.
  static bool hasCritical(List<ReadinessIssue> issues) =>
      issues.any((i) => i.severity == ReadinessSeverity.critical);

  /// The server has tried to reach this phone and failed repeatedly.
  ///
  /// Distinct from "a setting looks wrong": this is measured, and it is what
  /// justifies interrupting a driver who believes they are working.
  bool get provenUnreachable =>
      lastServerReachability == 'UNREACHABLE' && lastFailedWakes >= 2;
}
