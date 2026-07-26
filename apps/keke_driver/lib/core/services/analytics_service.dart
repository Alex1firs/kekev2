import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where a structured event goes. Swapped in tests, and the seam a real
/// analytics backend (Firebase/Amplitude) plugs into later without touching any
/// call site.
typedef AnalyticsSink = void Function(String event, Map<String, Object?> params);

/// Structured, machine-readable event logging for driver-facing coordination.
///
/// One line per event so it can be grepped out of `logcat`/Crashlytics and
/// aggregated ("what share of drivers who said 'still coming' actually arrived?")
/// without a third-party SDK in the build. Mirrors the passenger app's service so
/// both halves of one delayed ride can be joined on `rideId` and `eventId`.
class AnalyticsService {
  final AnalyticsSink _sink;
  final DateTime Function() _clock;

  AnalyticsService({AnalyticsSink? sink, DateTime Function()? clock})
      : _sink = sink ?? _defaultSink,
        _clock = clock ?? DateTime.now;

  static void _defaultSink(String event, Map<String, Object?> params) {
    // ignore: avoid_print
    print('[ANALYTICS] ${jsonEncode({'event': event, ...params})}');
  }

  void log(String event, Map<String, Object?> params) {
    _sink(event, {
      ...params,
      'timestamp': _clock().toUtc().toIso8601String(),
    });
  }

  /// A coordination prompt, notification or response.
  ///
  /// Deliberately carries no message text and no coordinates. Knowing a
  /// coordination prompt was answered is useful; a log of where a driver was
  /// parked and what they said to their passenger is not ours to keep.
  void logCoordination(
    String event, {
    required String? rideId,
    required String? eventId,
    required String stage,
    String role = 'driver',
    Map<String, Object?> extra = const {},
  }) {
    log('coordination_$event', {
      'rideId': rideId,
      'eventId': eventId,
      'stage': stage,
      'role': role,
      ...extra,
    });
  }
}

final analyticsServiceProvider = Provider<AnalyticsService>((ref) {
  // The default sink stays on in release too — these lines are the only
  // coordination telemetry we have until a real analytics backend is wired up.
  return AnalyticsService();
});
