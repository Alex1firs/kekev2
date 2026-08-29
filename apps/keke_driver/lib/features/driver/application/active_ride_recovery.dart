/// Server-authoritative active-ride recovery for the driver app.
library;

import 'package:dio/dio.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../domain/driver_profile.dart';
import '../domain/trip_request.dart';

/// The one place that answers "is this driver currently on a ride".
///
/// ── Why the driver needs this as badly as the passenger ──────────────────
/// A driver who loses their ride cannot complete it. The passenger is standing
/// somewhere waiting for a Keke that, as far as the driver's phone is
/// concerned, no longer exists — and the fare cannot be settled.
///
/// The driver app's previous recovery lived inside `_initDriver()`, nested in
/// the profile fetch, and had three defects the passenger's shared:
///
///  1. `double.parse(rideData['pickupLat'].toString())` with no null guard.
///     One missing coordinate threw, and the catch turned a live ride into an
///     error banner.
///  2. Failure was indistinguishable from having no ride, so a driver whose
///     recovery failed was left `offline` — and `_maybeAutoResumeOnline()`
///     then took them Online while they still held a ride.
///  3. It never called `updateActiveRide()`, so the socket did not join
///     `ride:<id>` and the driver missed passenger chat and cancellations.
///
/// ── The server is the only authority ─────────────────────────────────────
/// Nothing here reads local storage or a notification payload. A driver can
/// close the app after accepting and reopen it after the passenger has
/// cancelled; only the server knows that.

/// Where a recovery attempt came from. Logged so a pattern of failures can be
/// traced to a trigger rather than guessed at.
enum DriverRecoverySource {
  coldStart,
  appResume,
  socketReconnect,
  networkReconnect,
  notificationTap,
  goOnlineGuard,
  manualRetry,
}

extension DriverRecoverySourceWire on DriverRecoverySource {
  String get wire {
    switch (this) {
      case DriverRecoverySource.coldStart: return 'cold_start';
      case DriverRecoverySource.appResume: return 'app_resume';
      case DriverRecoverySource.socketReconnect: return 'socket_reconnect';
      case DriverRecoverySource.networkReconnect: return 'network_reconnect';
      case DriverRecoverySource.notificationTap: return 'notification_tap';
      case DriverRecoverySource.goOnlineGuard: return 'go_online_guard';
      case DriverRecoverySource.manualRetry: return 'manual_retry';
    }
  }
}

enum DriverRecoveryOutcome {
  /// A live ride exists and is described by the snapshot.
  found,

  /// This driver holds no live ride. Safe to go Online.
  none,

  /// We could not find out. Deliberately distinct from [none] — treating
  /// "could not ask" as "no ride" is what allowed a driver to be taken Online
  /// while still holding one.
  failed,
}

class DriverActiveRideSnapshot {
  const DriverActiveRideSnapshot({
    required this.request,
    required this.step,
    required this.status,
    this.coordination,
  });

  final TripRequest request;
  final TripStep step;

  /// The server's own status string, unmapped.
  final String status;

  final Map<String, dynamic>? coordination;

  /// Statuses the server treats as a driver being busy. Mirrors the `In([...])`
  /// in ride_routes.ts `/active/driver`.
  static const nonTerminalStatuses = <String>{
    'accepted', 'arrived', 'in_progress', 'started',
  };

  static TripStep stepFor(String status) {
    switch (status) {
      case 'arrived': return TripStep.arrived;
      case 'in_progress':
      case 'started': return TripStep.started;
      case 'accepted': return TripStep.accepted;
      // An unrecognised live status keeps the driver on the ride rather than
      // freeing them. Being wrong towards "still busy" strands nobody.
      default: return TripStep.accepted;
    }
  }

  /// Parse the payload, tolerating anything missing.
  ///
  /// Returns null only when there is genuinely no usable ride. Every field is
  /// optional-safe: the old code called `double.parse` on four values without a
  /// guard, so a single null coordinate discarded the whole ride.
  static DriverActiveRideSnapshot? fromWire(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    final status = data['status']?.toString();
    if (rideId == null || rideId.isEmpty || status == null) return null;
    if (!nonTerminalStatuses.contains(status)) return null;

    double? num_(dynamic v) {
      if (v == null) return null;
      if (v is num) return v.toDouble();
      return double.tryParse(v.toString());
    }

    final contact = data['passengerContact'];
    final contactMap = contact is Map
        ? contact.map((k, v) => MapEntry(k.toString(), v))
        : const <String, dynamic>{};

    final pickupLat = num_(data['pickupLat']);
    final pickupLng = num_(data['pickupLng']);
    final destLat = num_(data['destinationLat']);
    final destLng = num_(data['destinationLng']);

    return DriverActiveRideSnapshot(
      status: status,
      step: stepFor(status),
      coordination: data['coordination'] is Map
          ? (data['coordination'] as Map).map((k, v) => MapEntry(k.toString(), v))
          : null,
      request: TripRequest(
        id: rideId,
        passengerId: data['passengerId']?.toString() ?? '',
        isCash: data['paymentMode']?.toString() == 'cash',
        // The backend returns the passenger's contact on this endpoint
        // precisely so a restarted driver can still phone them. The old
        // recovery hardcoded 'User' and dropped the number entirely.
        // `firstName` is what the server actually sends (FullContact). The
        // `name` key was never emitted by any endpoint — reading it first meant
        // recovery always fell through to 'Passenger', so a driver who
        // restarted mid-ride collected somebody whose name the app had.
        passengerName: contactMap['firstName']?.toString() ??
            contactMap['name']?.toString() ??
            data['passengerName']?.toString() ??
            'Passenger',
        passengerPhone: contactMap['phone']?.toString(),
        pickupAddress: data['pickupAddress']?.toString() ?? '',
        pickupLocation: (pickupLat != null && pickupLng != null)
            ? LatLng(pickupLat, pickupLng)
            : const LatLng(0, 0),
        destinationAddress: data['destinationAddress']?.toString() ?? '',
        destinationLocation: (destLat != null && destLng != null)
            ? LatLng(destLat, destLng)
            : const LatLng(0, 0),
        fare: num_(data['finalFare']) ?? num_(data['fare']) ?? 0,
        distance: 0,
        pickupCode: data['pickupCode']?.toString(),
      ),
    );
  }
}

class DriverRecoveryResult {
  const DriverRecoveryResult(this.outcome, {this.snapshot, this.error});

  final DriverRecoveryOutcome outcome;
  final DriverActiveRideSnapshot? snapshot;
  final String? error;

  bool get found => outcome == DriverRecoveryOutcome.found;
  bool get resolved => outcome != DriverRecoveryOutcome.failed;
}

typedef RecoveryLogger = void Function(String event, Map<String, Object?> params);

class DriverActiveRideRecoveryService {
  DriverActiveRideRecoveryService(this._dio, {RecoveryLogger? log})
      : _log = log ?? _defaultLog;

  final Dio _dio;
  final RecoveryLogger _log;

  static const endpoint = '/rides/active/driver';

  static void _defaultLog(String event, Map<String, Object?> params) {
    // ignore: avoid_print
    print('[DRIVER_RECOVERY] $event $params');
  }

  Future<DriverRecoveryResult> fetch({required DriverRecoverySource source}) async {
    _log('active_ride_recovery_started', {'source': source.wire});

    try {
      final response = await _dio.get(
        endpoint,
        queryParameters: {'source': source.wire},
      );
      final raw = response.data;

      // `{}` with a 200 is the server's "no live ride", so an ordinary absence
      // never looks like a transport failure.
      if (raw is! Map || raw['rideId'] == null) {
        _log('active_ride_recovery_none', {'source': source.wire});
        return const DriverRecoveryResult(DriverRecoveryOutcome.none);
      }

      final snap = DriverActiveRideSnapshot.fromWire(
        raw.map((k, v) => MapEntry(k.toString(), v)),
      );
      if (snap == null) {
        _log('active_ride_recovery_none',
            {'source': source.wire, 'reason': 'terminal_or_unparseable'});
        return const DriverRecoveryResult(DriverRecoveryOutcome.none);
      }

      _log('active_ride_recovery_found', {
        'source': source.wire,
        'rideId': snap.request.id,
        'status': snap.status,
        'hasCoordination': snap.coordination != null,
      });
      return DriverRecoveryResult(DriverRecoveryOutcome.found, snapshot: snap);
    } catch (e) {
      final kind = e is DioException ? e.type.name : e.runtimeType.toString();
      _log('active_ride_recovery_failed', {'source': source.wire, 'error': kind});
      return DriverRecoveryResult(DriverRecoveryOutcome.failed, error: kind);
    }
  }
}
