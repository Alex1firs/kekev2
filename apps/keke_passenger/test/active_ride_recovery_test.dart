/// Active-ride recovery after process death.
///
/// The bug these exist for: a passenger with a driver en route force-closed the
/// app, reopened it, and was returned to "Where to?" — sometimes with
/// "Something went wrong on our end". The ride was alive on the server the
/// whole time.
///
/// Every test here asserts against what the SERVER said, never against
/// anything the app remembered. That is the property that was broken.

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:keke_passenger/core/services/analytics_service.dart';
import 'package:keke_passenger/features/passenger/application/active_ride_recovery.dart';
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';

/// Records what was logged, so the observability contract is tested rather
/// than assumed.
class _RecordingAnalytics implements AnalyticsService {
  final events = <String>[];
  final params = <String, Map<String, Object?>>{};

  @override
  void log(String event, Map<String, Object?> p) {
    events.add(event);
    params[event] = p;
  }

  @override
  noSuchMethod(Invocation invocation) => null;
}

/// A Dio whose next answer is whatever the test says it is.
class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.respond);

  Future<ResponseBody> Function(RequestOptions) respond;

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<List<int>>? _, Future<void>? __) =>
      respond(options);

  @override
  void close({bool force = false}) {}
}

Dio _dioReturning(Map<String, dynamic> body, {int status = 200}) {
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  dio.httpClientAdapter = _StubAdapter((_) async => ResponseBody.fromString(
        _json(body),
        status,
        headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
      ));
  return dio;
}

Dio _dioThrowing(DioExceptionType type) {
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  dio.httpClientAdapter = _StubAdapter((options) async =>
      throw DioException(requestOptions: options, type: type));
  return dio;
}

String _json(Map<String, dynamic> m) {
  // Small hand-rolled encoder so the test has no dependency on dart:convert
  // import ordering with the analyzer's lint set.
  final buf = StringBuffer('{');
  var first = true;
  m.forEach((k, v) {
    if (!first) buf.write(',');
    first = false;
    buf.write('"$k":');
    if (v == null) {
      buf.write('null');
    } else if (v is num || v is bool) {
      buf.write('$v');
    } else if (v is Map<String, dynamic>) {
      buf.write(_json(v));
    } else {
      buf.write('"${v.toString().replaceAll('"', '\\"')}"');
    }
  });
  buf.write('}');
  return buf.toString();
}

Map<String, dynamic> _ride(String status, {Map<String, dynamic>? extra}) => {
      'rideId': 'RIDE-abc',
      'status': status,
      'pickupLat': 6.2109,
      'pickupLng': 7.0740,
      'pickupAddress': 'Onitsha North',
      'destinationLat': 6.1400,
      'destinationLng': 6.8000,
      'destinationAddress': 'UNIZIK Gate',
      'fare': '850.00',
      ...?extra,
    };

void main() {
  late _RecordingAnalytics analytics;
  setUp(() => analytics = _RecordingAnalytics());

  // ══════════════════════════════════════════════════════════════════
  //  The reported failure: killed app, live ride
  // ══════════════════════════════════════════════════════════════════

  group('a ride that is alive on the server is recovered', () {
    test('accepted ride → confirmed (driver en route) screen', () async {
      final svc = ActiveRideRecoveryService(
        _dioReturning(_ride('accepted', extra: {
          'driverDetails': {'name': 'Chidi Okeke', 'plate': 'ABC-123-XY'},
        })),
        analytics,
      );

      final r = await svc.fetch(source: RecoverySource.coldStart);

      expect(r.outcome, RecoveryOutcome.found);
      expect(r.snapshot!.step, BookingStep.confirmed);
      expect(r.snapshot!.rideId, 'RIDE-abc');
      // The old recovery dropped this entirely, so a restored ride showed a
      // tracking screen with no driver on it.
      expect(r.snapshot!.driverDetails!['name'], 'Chidi Okeke');
    });

    test('arrived ride → arrived screen', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('arrived')), analytics);
      final r = await svc.fetch(source: RecoverySource.coldStart);
      expect(r.snapshot!.step, BookingStep.arrived);
    });

    test('in_progress ride → active trip screen', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('in_progress')), analytics);
      expect((await svc.fetch(source: RecoverySource.coldStart)).snapshot!.step,
          BookingStep.started);
    });

    test('started is treated the same as in_progress', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('started')), analytics);
      expect((await svc.fetch(source: RecoverySource.coldStart)).snapshot!.step,
          BookingStep.started);
    });

    test('searching ride → searching screen', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('searching')), analytics);
      expect((await svc.fetch(source: RecoverySource.coldStart)).snapshot!.step,
          BookingStep.searching);
    });

    test('a coordination block survives the round trip', () async {
      final svc = ActiveRideRecoveryService(
        _dioReturning(_ride('accepted', extra: {
          'coordination': {'stage': 'CANCELLATION_REQUESTED', 'eventId': 'evt-1'},
        })),
        analytics,
      );
      final r = await svc.fetch(source: RecoverySource.coldStart);
      expect(r.snapshot!.coordination!['stage'], 'CANCELLATION_REQUESTED');
    });

    /*
     * The whole point. The app was killed at `accepted`; the driver arrived
     * while it was dead. Reopening must show ARRIVED, not the remembered
     * ACCEPTED.
     */
    test('server state wins over whatever the app last saw', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('arrived')), analytics);
      final r = await svc.fetch(source: RecoverySource.appResume);
      expect(r.snapshot!.status, 'arrived');
      expect(r.snapshot!.step, BookingStep.arrived);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Absence, and the far more dangerous "we could not ask"
  // ══════════════════════════════════════════════════════════════════

  group('no active ride', () {
    test('an empty object is a clean "none"', () async {
      final svc = ActiveRideRecoveryService(_dioReturning({}), analytics);
      final r = await svc.fetch(source: RecoverySource.coldStart);
      expect(r.outcome, RecoveryOutcome.none);
      expect(analytics.events, contains('active_ride_recovery_none'));
    });
  });

  group('terminal rides are never restored', () {
    for (final status in ['completed', 'cancelled', 'failed', 'expired']) {
      test('$status is not a recovery', () async {
        final svc = ActiveRideRecoveryService(_dioReturning(_ride(status)), analytics);
        final r = await svc.fetch(source: RecoverySource.coldStart);
        expect(r.outcome, RecoveryOutcome.none,
            reason: 'a $status ride must send the passenger to the booking screen');
      });
    }
  });

  group('a failed check is not an absent ride', () {
    for (final type in [
      DioExceptionType.connectionTimeout,
      DioExceptionType.connectionError,
      DioExceptionType.receiveTimeout,
      DioExceptionType.badResponse,
    ]) {
      test('${type.name} yields failed, never none', () async {
        final svc = ActiveRideRecoveryService(_dioThrowing(type), analytics);
        final r = await svc.fetch(source: RecoverySource.coldStart);

        // If this ever returns `none`, a passenger with a driver on the way is
        // sent back to "Where to?" — the reported bug, exactly.
        expect(r.outcome, RecoveryOutcome.failed);
        expect(r.resolved, isFalse);
        expect(analytics.events, contains('active_ride_recovery_failed'));
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  Parsing details that silently lost data before
  // ══════════════════════════════════════════════════════════════════

  group('payload parsing', () {
    test('a numeric-string fare survives', () async {
      // Postgres numeric arrives as "850.00"; int.tryParse rejects that
      // outright, which is how the old recovery lost the fare.
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('accepted')), analytics);
      expect((await svc.fetch(source: RecoverySource.coldStart)).snapshot!.fare, 850);
    });

    test('a missing rideId is not a ride', () {
      expect(ActiveRideSnapshot.fromWire({'status': 'accepted'}), isNull);
    });

    test('an unknown non-terminal status is refused rather than guessed', () {
      expect(ActiveRideSnapshot.fromWire({'rideId': 'r', 'status': 'teleporting'}), isNull);
    });

    test('every status the backend calls live is handled', () {
      // Mirrors the In([...]) in ride_routes.ts. If the backend adds one and
      // this is not updated, this test is where it should be noticed.
      expect(ActiveRideSnapshot.nonTerminalStatuses,
          {'searching', 'accepted', 'arrived', 'in_progress', 'started'});
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Observability
  // ══════════════════════════════════════════════════════════════════

  group('recovery reports what happened', () {
    test('a found ride logs the source, id and status', () async {
      final svc = ActiveRideRecoveryService(_dioReturning(_ride('arrived')), analytics);
      await svc.fetch(source: RecoverySource.notificationTap);

      expect(analytics.events, contains('active_ride_recovery_started'));
      expect(analytics.events, contains('active_ride_recovery_found'));
      final p = analytics.params['active_ride_recovery_found']!;
      expect(p['source'], 'notification_tap');
      expect(p['rideId'], 'RIDE-abc');
      expect(p['status'], 'arrived');
    });

    test('no passenger contact details are ever logged', () async {
      final svc = ActiveRideRecoveryService(
        _dioReturning(_ride('accepted', extra: {
          'driverDetails': {'name': 'Chidi', 'phone': '08030000000'},
        })),
        analytics,
      );
      await svc.fetch(source: RecoverySource.coldStart);

      final logged = analytics.params.values
          .expand((m) => m.values)
          .map((v) => v.toString())
          .join(' ');
      expect(logged.contains('08030000000'), isFalse);
      expect(logged.contains('Chidi'), isFalse);
    });

    test('every source has a stable wire name', () {
      for (final s in RecoverySource.values) {
        expect(s.wire, isNotEmpty);
        expect(s.wire, matches(RegExp(r'^[a-z_]+$')));
      }
    });
  });
}
