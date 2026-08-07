/// Driver-side active-ride recovery after process death.
///
/// A driver who loses their ride cannot complete it: the passenger is standing
/// somewhere waiting for a Keke that, as far as the driver's phone knows, does
/// not exist, and the fare cannot be settled. These assert against what the
/// SERVER said, never against anything the app remembered.

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:keke_driver/features/driver/application/active_ride_recovery.dart';
import 'package:keke_driver/features/driver/domain/driver_profile.dart';

class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.respond);
  Future<ResponseBody> Function(RequestOptions) respond;

  @override
  Future<ResponseBody> fetch(
          RequestOptions o, Stream<List<int>>? _, Future<void>? __) =>
      respond(o);

  @override
  void close({bool force = false}) {}
}

String _json(Map<String, dynamic> m) {
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

Dio _dioReturning(Map<String, dynamic> body) {
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  dio.httpClientAdapter = _StubAdapter((_) async => ResponseBody.fromString(
        _json(body),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        },
      ));
  return dio;
}

Dio _dioThrowing(DioExceptionType type) {
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  dio.httpClientAdapter = _StubAdapter(
      (o) async => throw DioException(requestOptions: o, type: type));
  return dio;
}

Map<String, dynamic> _ride(String status, {Map<String, dynamic>? extra}) => {
      'rideId': 'RIDE-live-1',
      'status': status,
      'passengerId': 'passenger-9',
      'paymentMode': 'cash',
      'pickupLat': 6.2109,
      'pickupLng': 7.0740,
      'pickupAddress': 'Main Market, Onitsha',
      'destinationLat': 6.1400,
      'destinationLng': 6.8000,
      'destinationAddress': 'UNIZIK Gate',
      'fare': '850.00',
      'pickupCode': '4821',
      ...?extra,
    };

void main() {
  late List<String> logged;
  late List<Map<String, Object?>> params;

  DriverActiveRideRecoveryService svc(Dio dio) =>
      DriverActiveRideRecoveryService(dio, log: (e, p) {
        logged.add(e);
        params.add(p);
      });

  setUp(() {
    logged = [];
    params = [];
  });

  // ══════════════════════════════════════════════════════════════════
  //  Accept → kill → reopen
  // ══════════════════════════════════════════════════════════════════

  group('a ride the driver accepted survives process death', () {
    test('accepted → the trip screen is restored', () async {
      final r = await svc(_dioReturning(_ride('accepted')))
          .fetch(source: DriverRecoverySource.coldStart);

      expect(r.outcome, DriverRecoveryOutcome.found);
      expect(r.snapshot!.step, TripStep.accepted);
      expect(r.snapshot!.request.id, 'RIDE-live-1');
      expect(r.snapshot!.request.pickupAddress, 'Main Market, Onitsha');
      expect(r.snapshot!.request.fare, 850);
      expect(r.snapshot!.request.pickupCode, '4821');
    });

    test('arrived → the arrived state is restored', () async {
      final r = await svc(_dioReturning(_ride('arrived')))
          .fetch(source: DriverRecoverySource.coldStart);
      expect(r.snapshot!.step, TripStep.arrived);
    });

    test('in_progress → the active trip is restored', () async {
      final r = await svc(_dioReturning(_ride('in_progress')))
          .fetch(source: DriverRecoverySource.coldStart);
      expect(r.snapshot!.step, TripStep.started);
    });

    /*
     * The backend returns passengerContact on this endpoint specifically so a
     * restarted driver can still phone their passenger. The old recovery
     * hardcoded `passengerName: 'User'` and dropped the number, so a driver who
     * restarted mid-ride could not call the person they were collecting.
     */
    test('the passenger name and phone are restored, not a placeholder',
        () async {
      final r = await svc(_dioReturning(_ride('accepted', extra: {
        'passengerContact': {'name': 'Ada Obi', 'phone': '08031234567'},
      }))).fetch(source: DriverRecoverySource.coldStart);

      expect(r.snapshot!.request.passengerName, 'Ada Obi');
      expect(r.snapshot!.request.passengerPhone, '08031234567');
      expect(r.snapshot!.request.passengerName, isNot('User'));
    });

    test('server state wins over what the driver last saw', () async {
      // Killed at accepted; the driver marked arrived from another device, or
      // the trip was started. Reopening must show the newer state.
      final r = await svc(_dioReturning(_ride('in_progress')))
          .fetch(source: DriverRecoverySource.appResume);
      expect(r.snapshot!.status, 'in_progress');
      expect(r.snapshot!.step, TripStep.started);
    });

    test('a coordination block survives the round trip', () async {
      final r = await svc(_dioReturning(_ride('accepted', extra: {
        'coordination': {'stage': 'awaiting_decision', 'eventId': 'evt-3'},
      }))).fetch(source: DriverRecoverySource.coldStart);
      expect(r.snapshot!.coordination!['eventId'], 'evt-3');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  The parsing bug that discarded whole rides
  // ══════════════════════════════════════════════════════════════════

  group('a malformed payload never costs the driver the ride', () {
    /*
     * The old code called double.parse(rideData['pickupLat'].toString()) on
     * four values with no null guard. One missing coordinate threw, the catch
     * turned a live ride into an error banner, and the driver lost the trip.
     */
    test('missing coordinates still restore the ride', () async {
      final r = await svc(_dioReturning({
        'rideId': 'RIDE-live-1',
        'status': 'accepted',
        'passengerId': 'passenger-9',
      })).fetch(source: DriverRecoverySource.coldStart);

      expect(r.outcome, DriverRecoveryOutcome.found,
          reason: 'a ride with no pickup coordinate is still a ride the driver '
              'is on and must complete');
      expect(r.snapshot!.request.id, 'RIDE-live-1');
    });

    test('a numeric-string fare survives', () async {
      final r = await svc(_dioReturning(_ride('accepted')))
          .fetch(source: DriverRecoverySource.coldStart);
      expect(r.snapshot!.request.fare, 850);
    });

    test('finalFare is preferred over the quoted fare', () async {
      final r = await svc(_dioReturning(_ride('in_progress', extra: {
        'finalFare': '920.00',
      }))).fetch(source: DriverRecoverySource.coldStart);
      expect(r.snapshot!.request.fare, 920);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Absence vs. "could not ask"
  // ══════════════════════════════════════════════════════════════════

  group('no ride', () {
    test('an empty object is a clean none', () async {
      final r = await svc(_dioReturning({}))
          .fetch(source: DriverRecoverySource.coldStart);
      expect(r.outcome, DriverRecoveryOutcome.none);
      expect(logged, contains('active_ride_recovery_none'));
    });

    for (final status in ['completed', 'canceled', 'failed']) {
      test('a $status ride is not restored', () async {
        final r = await svc(_dioReturning(_ride(status)))
            .fetch(source: DriverRecoverySource.coldStart);
        expect(r.outcome, DriverRecoveryOutcome.none);
      });
    }
  });

  group('a failed check is never read as "no ride"', () {
    for (final type in [
      DioExceptionType.connectionTimeout,
      DioExceptionType.connectionError,
      DioExceptionType.receiveTimeout,
      DioExceptionType.badResponse,
    ]) {
      test('${type.name} yields failed', () async {
        final r = await svc(_dioThrowing(type))
            .fetch(source: DriverRecoverySource.coldStart);

        /*
         * This is the distinction that keeps a driver off the available pool
         * while they are secretly still carrying a passenger. If this ever
         * returns `none`, _maybeAutoResumeOnline() will take them Online.
         */
        expect(r.outcome, DriverRecoveryOutcome.failed);
        expect(r.resolved, isFalse);
        expect(logged, contains('active_ride_recovery_failed'));
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  Contract with the backend
  // ══════════════════════════════════════════════════════════════════

  group('status contract', () {
    test('matches the statuses /rides/active/driver queries', () {
      // Mirrors In(["accepted","arrived","in_progress","started"]) in
      // ride_routes.ts. If the backend adds one and this is not updated, this
      // is where it should be noticed.
      expect(DriverActiveRideSnapshot.nonTerminalStatuses,
          {'accepted', 'arrived', 'in_progress', 'started'});
    });

    test('an unknown live status keeps the driver on the ride', () {
      // Being wrong towards "still busy" strands nobody. Being wrong the other
      // way frees a driver who is mid-trip.
      expect(DriverActiveRideSnapshot.stepFor('some_new_state'),
          TripStep.accepted);
    });

    test('every recovery source has a stable wire name', () {
      for (final s in DriverRecoverySource.values) {
        expect(s.wire, matches(RegExp(r'^[a-z_]+$')));
      }
    });

    test('the source travels with the request', () async {
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      String? seen;
      dio.httpClientAdapter = _StubAdapter((o) async {
        seen = o.queryParameters['source']?.toString();
        return ResponseBody.fromString('{}', 200, headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        });
      });
      await svc(dio).fetch(source: DriverRecoverySource.goOnlineGuard);
      expect(seen, 'go_online_guard');
    });

    test('no passenger phone reaches a log', () async {
      await svc(_dioReturning(_ride('accepted', extra: {
        'passengerContact': {'name': 'Ada Obi', 'phone': '08031234567'},
      }))).fetch(source: DriverRecoverySource.coldStart);

      final all = params.expand((m) => m.values).map((v) => '$v').join(' ');
      expect(all.contains('08031234567'), isFalse);
      expect(all.contains('Ada Obi'), isFalse);
    });
  });
}
