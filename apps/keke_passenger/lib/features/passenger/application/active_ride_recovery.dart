/// Server-authoritative active-ride recovery for the passenger app.
library;

import 'package:dio/dio.dart';

import '../../../core/services/analytics_service.dart';
import '../domain/booking_state.dart';

/// The one place that answers "does this passenger have a live ride right now".
///
/// ── Why this exists as its own file ──────────────────────────────────────
/// Recovery used to be a side effect buried inside `_initializeMap()`, the
/// method that sets up the map. It ran once, in a constructor, after an
/// `await getCurrentLocation()` — so the "Where to?" screen was painted first
/// by construction — and it restored only part of the ride. A second, more
/// complete healer lived in `syncStatus()`, but that one refused to run unless
/// `state.rideId` was already set, which is never true after process death.
///
/// Two half-implementations that disagreed about what a ride is. This is the
/// single implementation both now call.
///
/// ── The server is the only authority ─────────────────────────────────────
/// Nothing here reads local storage, a notification payload, or cached driver
/// state. A passenger can close the app while the driver is en route and reopen
/// it after the driver has arrived; only the server knows that. Anything this
/// class returns came from `/rides/active/passenger` in the request that
/// produced it.
/// Where a recovery attempt came from. Reported in analytics so a pattern of
/// failures can be traced to the trigger rather than guessed at.
enum RecoverySource {
  coldStart,
  appResume,
  socketReconnect,
  networkReconnect,
  loginSuccess,
  notificationTap,
  activeRideExistsFallback,
  /// The 20-second heartbeat that runs for the whole of a live trip.
  liveTripReconcile,
  manualRetry,
}

extension RecoverySourceWire on RecoverySource {
  String get wire {
    switch (this) {
      case RecoverySource.coldStart: return 'cold_start';
      case RecoverySource.appResume: return 'app_resume';
      case RecoverySource.socketReconnect: return 'socket_reconnect';
      case RecoverySource.networkReconnect: return 'network_reconnect';
      case RecoverySource.loginSuccess: return 'login_success';
      case RecoverySource.notificationTap: return 'notification_tap';
      case RecoverySource.activeRideExistsFallback: return 'active_ride_exists_fallback';
      case RecoverySource.liveTripReconcile: return 'live_trip_reconcile';
      case RecoverySource.manualRetry: return 'manual_retry';
    }
  }
}

/// What the server said. One of exactly three answers.
enum RecoveryOutcome {
  /// A non-terminal ride exists and is described by [ActiveRideRecoveryResult.snapshot].
  found,

  /// The passenger has no live ride. Safe to show the booking home screen.
  none,

  /// We could not find out — offline, timeout, 5xx, expired session.
  ///
  /// Deliberately distinct from [none]. Treating "we could not ask" as "there
  /// is no ride" is exactly the bug this class exists to prevent: it would send
  /// a passenger with a driver on the way back to the booking screen.
  failed,
}

/// A live ride, as the server described it.
class ActiveRideSnapshot {
  const ActiveRideSnapshot({
    required this.rideId,
    required this.status,
    required this.step,
    this.pickupLat,
    this.pickupLng,
    this.pickupAddress,
    this.destinationLat,
    this.destinationLng,
    this.destinationAddress,
    this.fare,
    this.driverDetails,
    this.coordination,
    this.pickupCode,
    this.paymentMode,
    this.driverGpsAgeSeconds,
  });

  final String rideId;

  /// The server's own status string, unmapped. Kept so logs and tests can
  /// assert on what the server actually said rather than on our translation.
  final String status;

  final BookingStep step;
  final double? pickupLat;
  final double? pickupLng;
  final String? pickupAddress;
  final double? destinationLat;
  final double? destinationLng;
  final String? destinationAddress;
  final int? fare;
  final Map<String, dynamic>? driverDetails;
  final Map<String, dynamic>? coordination;
  final String? pickupCode;
  final String? paymentMode;

  /// How long ago the driver's GPS last reached the server.
  ///
  /// Distinguishes "our socket is stale" from "the driver's phone stopped
  /// publishing" — identical on a frozen map, opposite remedies.
  final int? driverGpsAgeSeconds;

  /// Ride states the server treats as live. Mirrors the `In([...])` in
  /// `ride_routes.ts` — if one side gains a state the other must too, so the
  /// list is written out rather than inferred.
  static const nonTerminalStatuses = <String>{
    'searching', 'accepted', 'arrived', 'in_progress', 'started',
  };

  /// Map a server status onto the screen that should be showing.
  ///
  /// An unrecognised non-terminal status maps to [BookingStep.searching] rather
  /// than to the home screen: if the server has invented a state this build has
  /// never heard of, the passenger still has a ride, and showing them "Where
  /// to?" would be the worst of the available wrong answers.
  static BookingStep stepFor(String status) {
    switch (status) {
      case 'accepted': return BookingStep.confirmed;
      case 'arrived': return BookingStep.arrived;
      case 'in_progress':
      case 'started': return BookingStep.started;
      case 'searching': return BookingStep.searching;
      default: return BookingStep.searching;
    }
  }

  static ActiveRideSnapshot? fromWire(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    final status = data['status']?.toString();
    if (rideId == null || rideId.isEmpty || status == null) return null;

    // A terminal ride is not a recovery. The server should not return one, but
    // if it ever does, treating it as live would strand the passenger on a
    // tracking screen for a trip that has ended.
    if (!nonTerminalStatuses.contains(status)) return null;

    double? d(String key) => (data[key] as num?)?.toDouble();
    Map<String, dynamic>? m(String key) {
      final v = data[key];
      if (v is Map) return v.map((k, val) => MapEntry(k.toString(), val));
      return null;
    }

    return ActiveRideSnapshot(
      rideId: rideId,
      status: status,
      step: stepFor(status),
      pickupLat: d('pickupLat'),
      pickupLng: d('pickupLng'),
      pickupAddress: data['pickupAddress']?.toString(),
      destinationLat: d('destinationLat'),
      destinationLng: d('destinationLng'),
      destinationAddress: data['destinationAddress']?.toString(),
      // Fares arrive as "500.00" from Postgres numeric. int.tryParse rejects
      // that outright, which is why the old recovery silently lost the fare.
      fare: _parseFare(data['finalFare'] ?? data['fare']),
      driverDetails: m('driverDetails'),
      coordination: m('coordination'),
      pickupCode: data['pickupCode']?.toString(),
      paymentMode: data['paymentMode']?.toString(),
      driverGpsAgeSeconds: (data['driverGpsAgeSeconds'] as num?)?.round(),
    );
  }

  static int? _parseFare(dynamic raw) {
    if (raw == null) return null;
    if (raw is num) return raw.round();
    final parsed = double.tryParse(raw.toString());
    return parsed?.round();
  }
}

class ActiveRideRecoveryResult {
  const ActiveRideRecoveryResult(this.outcome, {this.snapshot, this.error});

  final RecoveryOutcome outcome;
  final ActiveRideSnapshot? snapshot;
  final String? error;

  bool get found => outcome == RecoveryOutcome.found;
  bool get resolved => outcome != RecoveryOutcome.failed;
}

/// Asks the server, and reports what it said.
///
/// Deliberately has no opinion about UI. It does not touch booking state, does
/// not navigate and does not decide what a failure should look like — the
/// controller owns that. Keeping it that way is what stops a third recovery
/// implementation growing here later.
class ActiveRideRecoveryService {
  ActiveRideRecoveryService(this._dio, this._analytics);

  final Dio _dio;
  final AnalyticsService _analytics;

  static const endpoint = '/rides/active/passenger';

  Future<ActiveRideRecoveryResult> fetch({required RecoverySource source}) async {
    _analytics.log('active_ride_recovery_started', {'source': source.wire});

    try {
      // The source travels with the request so the backend log can attribute a
      // pattern of failures to a trigger. It is a hint only; the server logs it
      // and never acts on it.
      final response = await _dio.get(
        endpoint,
        queryParameters: {'source': source.wire},
      );
      final raw = response.data;

      // `{}` is the server's "no live ride" answer — a 200, not a 404, so an
      // ordinary absence never looks like a failure to Dio.
      if (raw is! Map || raw['rideId'] == null) {
        _analytics.log('active_ride_recovery_none', {'source': source.wire});
        return const ActiveRideRecoveryResult(RecoveryOutcome.none);
      }

      final snapshot = ActiveRideSnapshot.fromWire(
        raw.map((k, v) => MapEntry(k.toString(), v)),
      );
      if (snapshot == null) {
        _analytics.log('active_ride_recovery_none', {
          'source': source.wire,
          'reason': 'terminal_or_unparseable',
        });
        return const ActiveRideRecoveryResult(RecoveryOutcome.none);
      }

      _analytics.log('active_ride_recovery_found', {
        'source': source.wire,
        'rideId': snapshot.rideId,
        'status': snapshot.status,
        'hasDriver': snapshot.driverDetails != null,
        'hasCoordination': snapshot.coordination != null,
      });
      return ActiveRideRecoveryResult(RecoveryOutcome.found, snapshot: snapshot);
    } catch (e) {
      /*
       * Failure is NOT absence. The caller must keep whatever it was showing
       * and retry — never fall through to the booking screen, and never show a
       * destructive error, because the most likely cause is a phone that has
       * just woken up with no network yet.
       */
      final kind = e is DioException ? (e.type.name) : e.runtimeType.toString();
      _analytics.log('active_ride_recovery_failed', {
        'source': source.wire,
        'error': kind,
      });
      return ActiveRideRecoveryResult(RecoveryOutcome.failed, error: kind);
    }
  }
}
