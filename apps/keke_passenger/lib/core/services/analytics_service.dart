import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/passenger/domain/booking_notice.dart';

/// Where a structured event goes. Swapped in tests, and the seam a real
/// analytics backend (Firebase/Amplitude) plugs into later without touching
/// any call site.
typedef AnalyticsSink = void Function(String event, Map<String, Object?> params);

/// Structured, machine-readable event logging for passenger-facing outcomes.
///
/// One line per event so it can be grepped out of `logcat`/Crashlytics and
/// aggregated ("what share of searches ended NO_DRIVER_ACCEPTED?") without a
/// third-party SDK in the build.
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

  /// A passenger started (or restarted) a search for a driver.
  void logSearchStarted({
    required String? rideId,
    required int searchAttempts,
    required int searchRound,
  }) {
    log('passenger_ride_search_started', {
      'rideId': rideId,
      'searchAttempts': searchAttempts,
      'searchRound': searchRound,
    });
  }

  /// A search ended without an assigned driver. [dispatchResult] is the
  /// server's account of what dispatch did, when it supplied one, and
  /// [dispatchEvidence] the per-round counts it reported (empty for older
  /// servers that send no structured data).
  void logRideOutcome({
    required String? rideId,
    required RideOutcome outcome,
    required int searchAttempts,
    String? dispatchResult,
    int? searchRound,
    Map<String, Object?> dispatchEvidence = const {},
  }) {
    log('passenger_ride_outcome', {
      'rideId': rideId,
      'outcomeCode': outcome.code,
      'tone': BookingNotice.of(outcome).isError ? 'error' : 'info',
      'dispatchResult': dispatchResult,
      'searchAttempts': searchAttempts,
      if (searchRound != null) 'searchRound': searchRound,
      ...dispatchEvidence,
    });
  }
}

final analyticsServiceProvider = Provider<AnalyticsService>((ref) {
  // The default sink stays on in release too — these lines are the only
  // outcome telemetry we have until a real analytics backend is wired up.
  return AnalyticsService();
});
