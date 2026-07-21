import 'dart:collection';

/// Structured, tagged logging for the driver background-reliability subsystem.
///
/// Two outputs:
///  - `print()` with a stable `[KEKE_REL]` tag so events are greppable in
///    `adb logcat` even while the screen is locked (works from BOTH the UI
///    isolate and the foreground-service isolate).
///  - An in-memory ring buffer the Diagnostics screen renders, so a driver in
///    the field can read the recent lifecycle without a computer.
///
/// Event names are fixed strings (see [RelEvent]) so logs are easy to filter.
class ReliabilityLog {
  ReliabilityLog._();

  static const String tag = 'KEKE_REL';
  static const int _maxEntries = 200;
  static final Queue<ReliabilityEntry> _buffer = Queue<ReliabilityEntry>();

  /// Emit a structured event. [fields] are flattened into the log line.
  static void log(String event, [Map<String, Object?> fields = const {}]) {
    final entry = ReliabilityEntry(
      event: event,
      // NOTE: DateTime.now() is fine here (runtime logging, not a workflow).
      at: DateTime.now(),
      fields: fields,
    );
    _buffer.addLast(entry);
    while (_buffer.length > _maxEntries) {
      _buffer.removeFirst();
    }
    // Single greppable line.
    final kv = fields.entries.map((e) => '${e.key}=${e.value}').join(' ');
    // ignore: avoid_print
    print('[$tag] $event${kv.isEmpty ? '' : ' $kv'}');
  }

  /// Most-recent-first snapshot for the diagnostics screen.
  static List<ReliabilityEntry> recent() => _buffer.toList().reversed.toList();

  static void clear() => _buffer.clear();
}

class ReliabilityEntry {
  final String event;
  final DateTime at;
  final Map<String, Object?> fields;
  ReliabilityEntry({required this.event, required this.at, required this.fields});
}

/// Canonical event names — keep in sync with the diagnostics/handoff doc.
class RelEvent {
  static const fgsStarted = 'fgs_started';
  static const fgsStopped = 'fgs_stopped';
  static const fgsRestarted = 'fgs_restarted';
  static const fgsInterrupted = 'fgs_interrupted';
  static const heartbeatSent = 'heartbeat_sent';
  static const heartbeatFailed = 'heartbeat_failed';
  static const locationObtained = 'location_obtained';
  static const locationFailed = 'location_failed';
  static const fcmReceived = 'fcm_received';
  static const rideNotificationShown = 'ride_notification_shown';
  static const rideNotificationDuplicateSuppressed = 'ride_notification_dupe_suppressed';
  static const batteryRestrictionDetected = 'battery_restriction_detected';
  static const backgroundLocationGranted = 'background_location_granted';
  static const backgroundLocationMissing = 'background_location_missing';
  static const networkLost = 'network_lost';
  static const networkRecovered = 'network_recovered';
  static const becameStale = 'became_stale';
  static const becameEligible = 'became_eligible';
  static const offlineStopped = 'offline_stopped';
  static const logoutCleanup = 'logout_cleanup';
}
