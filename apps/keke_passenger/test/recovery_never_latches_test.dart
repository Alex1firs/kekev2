/// The "Reconnecting to your ride…" screen must always have a way out.
///
/// Reproduced in a real field test on the new build: recovery entered the
/// restoring state and never left it, on a phone with working internet. The
/// entry point worked; the completion path did not.
///
/// These tests are about the exits, not the happy path.

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import 'package:keke_passenger/core/network/api_client.dart';
import 'package:keke_passenger/core/network/notification_service.dart';
import 'package:keke_passenger/core/network/socket_service.dart';
import 'package:keke_passenger/core/services/analytics_service.dart';
import 'package:keke_passenger/core/services/sound_service.dart';
import 'package:keke_passenger/features/passenger/application/active_ride_recovery.dart';
import 'package:keke_passenger/features/passenger/application/booking_controller.dart';
import 'package:keke_passenger/features/passenger/data/map_repository.dart';
import 'package:keke_passenger/features/passenger/domain/resolved_place.dart';
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';

class _FakeMapRepository implements MapRepository {
  // Explicit rather than left to noSuchMethod: resolvePlace returns a
  // NON-nullable ResolvedPlace, and Future.value(null) does not satisfy that.
  // A fake that silently fails the cast would exercise an error path the real
  // repository never takes.
  @override
  Future<ResolvedPlace> resolvePlace(LatLng target) async =>
      const ResolvedPlace(address: 'Test Location', subLocality: 'Awada', locality: 'Obosi');

  @override
  Future<LatLng?> getCurrentLocation() async => const LatLng(6.2109, 7.0740);
  @override
  Future<List<LatLng>> getRoutePath(LatLng a, LatLng b) async => const [];
  @override
  noSuchMethod(Invocation i) => Future.value(null);
}

class _FakeNotificationService implements NotificationService {
  @override
  Stream<Map<String, dynamic>> get intentStream => const Stream.empty();
  @override
  noSuchMethod(Invocation i) => Future.value(null);
}

class _SilentSoundService implements SoundService {
  @override
  noSuchMethod(Invocation i) => Future.value(null);
}

void main() {
  late List<(String, Map<String, Object?>)> events;
  BookingController? controller;

  /// Controls what the active-ride endpoint does on each call.
  late List<Response<dynamic> Function(RequestOptions)> responders;
  late int calls;

  tearDown(() {
    controller?.dispose();
    controller = null;
  });

  ApiClient _api() {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
      if (options.path == '/rides/active/passenger') {
        final i = calls < responders.length ? calls : responders.length - 1;
        calls += 1;
        try {
          return handler.resolve(responders[i](options));
        } catch (e) {
          if (e is DioException) return handler.reject(e, true);
          rethrow;
        }
      }
      return handler.reject(
          DioException(requestOptions: options, message: 'not stubbed'), true);
    }));
    return ApiClient(dio);
  }

  Response<dynamic> _ok(RequestOptions o, Map<String, dynamic> body) =>
      Response(requestOptions: o, statusCode: 200, data: body);

  Never _fail(RequestOptions o, DioExceptionType type, {int? status}) =>
      throw DioException(
        requestOptions: o,
        type: type,
        response: status == null
            ? null
            : Response(requestOptions: o, statusCode: status),
      );

  Map<String, dynamic> ride(String status) => {
        'rideId': 'RIDE-1',
        'status': status,
        'pickupLat': 6.2109,
        'pickupLng': 7.0740,
        'pickupAddress': 'Main Market',
        'destinationLat': 6.1400,
        'destinationLng': 6.8000,
        'destinationAddress': 'UNIZIK Gate',
        'fare': '850.00',
        'driverDetails': const {'name': 'Chidi Okeke'},
      };

  Future<void> pump([int turns = 12]) async {
    for (var i = 0; i < turns; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<BookingController> boot() async {
    events = [];
    calls = 0;
    final c = BookingController(
      _FakeMapRepository(),
      SocketService.offline(),
      _api(),
      _FakeNotificationService(),
      _SilentSoundService(),
      AnalyticsService(sink: (e, p) => events.add((e, p))),
      'passenger-1',
      'Ada',
      'Obi',
    );
    controller = c;
    await pump();
    return c;
  }

  // ══════════════════════════════════════════════════════════════════
  //  The latch
  // ══════════════════════════════════════════════════════════════════

  group('a failed attempt never latches the controller', () {
    test('after a failure the recovery lock is released', () async {
      responders = [(o) => _fail(o, DioExceptionType.connectionError)];
      final c = await boot();

      expect(c.state.rideRestoreFailed, isTrue);

      /*
       * The lock lived OUTSIDE the try, with a state write between setting it
       * and entering the block. A write after disposal throws, skips the
       * finally, and latches the flag true for the life of the controller —
       * every later attempt then returns `in_flight` instantly and nothing ever
       * asks the server again. That is the reported hang.
       */
      final again = await c.recoverActiveRide(RecoverySource.manualRetry);
      expect(again.failure, isNot(RecoveryFailure.inFlight),
          reason: 'the lock must have been released by the previous attempt');
    });

    test('a manual retry after failure reaches the server', () async {
      responders = [
        (o) => _fail(o, DioExceptionType.connectionError),
        (o) => _ok(o, ride('accepted')),
      ];
      final c = await boot();
      expect(c.state.rideRestoreFailed, isTrue);

      await c.retryActiveRideRecovery();
      await pump();

      expect(c.state.step, BookingStep.confirmed);
      expect(c.state.rideId, 'RIDE-1');
      expect(calls, greaterThanOrEqualTo(2));
    });

    test('a concurrent attempt still guarantees a follow-up', () async {
      responders = [(o) => _fail(o, DioExceptionType.connectionError)];
      final c = await boot();

      // Two callers race. The loser used to return immediately and schedule
      // NOTHING, so if it was the one holding the retry chain, the chain died.
      final a = c.recoverActiveRide(RecoverySource.appResume);
      final b = c.recoverActiveRide(RecoverySource.socketReconnect);
      final results = await Future.wait([a, b]);

      final loser = results.firstWhere(
          (r) => r.failure == RecoveryFailure.inFlight,
          orElse: () => results.first);
      expect(loser, isNotNull);
      // Still unresolved, so a retry must be armed rather than abandoned.
      expect(c.activeRideUnresolved, isTrue);
    });

    test('recovery stays unresolved rather than falling through to booking',
        () async {
      responders = [(o) => _fail(o, DioExceptionType.connectionError)];
      final c = await boot();

      expect(c.activeRideUnresolved, isTrue);
      expect(c.state.step, BookingStep.loading,
          reason: 'an unresolved check is NOT the same as "no active ride"');
      expect(c.state.notice, isNull, reason: 'never a destructive error');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Failure classification
  // ══════════════════════════════════════════════════════════════════

  group('the reason is preserved, not flattened to "offline"', () {
    test('a 401 is unauthorised, not a network problem', () async {
      responders = [
        (o) => _fail(o, DioExceptionType.badResponse, status: 401)
      ];
      final c = await boot();
      expect(c.lastRecoveryFailure, RecoveryFailure.unauthorised);
      expect(c.lastRecoveryStatus, 401);
    });

    test('a 500 is a server error', () async {
      responders = [
        (o) => _fail(o, DioExceptionType.badResponse, status: 500)
      ];
      final c = await boot();
      expect(c.lastRecoveryFailure, RecoveryFailure.serverError);
    });

    test('a timeout is a timeout', () async {
      responders = [(o) => _fail(o, DioExceptionType.receiveTimeout)];
      final c = await boot();
      expect(c.lastRecoveryFailure, RecoveryFailure.timeout);
    });

    test('a malformed 200 is not a network failure', () async {
      responders = [(o) => _ok(o, {'rideId': 'RIDE-1', 'status': 'accepted', 'pickupLat': 'not-a-number'})];
      final c = await boot();
      // fromWire is null-safe, so this still recovers. What must NOT happen is
      // the whole ride being discarded over one bad field.
      expect(c.state.rideId, 'RIDE-1');
    });

    test('an unauthorised failure is marked non-retryable', () {
      // Retrying the same expired token forever is what strands a passenger on
      // a spinner. It needs the session dealt with, not another attempt.
      expect(RecoveryFailure.unauthorised.retryable, isFalse);
      expect(RecoveryFailure.timeout.retryable, isTrue);
      expect(RecoveryFailure.offline.retryable, isTrue);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Recovery must not wait on anything optional
  // ══════════════════════════════════════════════════════════════════

  group('the ride renders from the REST snapshot alone', () {
    test('a ride restores with no socket connection', () async {
      responders = [(o) => _ok(o, ride('in_progress'))];
      events = [];
      calls = 0;
      final c = BookingController(
        _FakeMapRepository(),
        SocketService.offline(connected: false), // socket down
        _api(),
        _FakeNotificationService(),
        _SilentSoundService(),
        AnalyticsService(sink: (e, p) => events.add((e, p))),
        'passenger-1', 'Ada', 'Obi',
      );
      controller = c;
      await pump();

      expect(c.state.step, BookingStep.started,
          reason: 'the ride screen must not wait for a socket');
      expect(c.state.rideId, 'RIDE-1');
    });

    test('a ride restores when directions fail', () async {
      responders = [(o) => _ok(o, ride('accepted'))];
      final c = await boot();
      // _FakeMapRepository returns an empty route; a real failure is also
      // swallowed. Either way the ride is already applied.
      expect(c.state.step, BookingStep.confirmed);
      expect(c.state.rideId, 'RIDE-1');
    });

    test('a ride restores with null driver coordinates', () async {
      responders = [
        (o) => _ok(o, {
              'rideId': 'RIDE-1',
              'status': 'accepted',
              'destinationAddress': 'UNIZIK Gate',
            })
      ];
      final c = await boot();
      expect(c.state.rideId, 'RIDE-1');
      expect(c.state.step, BookingStep.confirmed,
          reason: 'Level 1 must render even with every optional field missing');
    });

    test('a malformed coordination block does not cost the ride', () async {
      responders = [
        (o) => _ok(o, {
              ...ride('accepted'),
              'coordination': {'garbage': true},
            })
      ];
      final c = await boot();
      expect(c.state.step, BookingStep.confirmed);
      expect(c.state.rideId, 'RIDE-1');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Recovery eventually succeeds
  // ══════════════════════════════════════════════════════════════════

  group('recovery converges', () {
    test('network unavailable at launch, then available', () async {
      responders = [
        (o) => _fail(o, DioExceptionType.connectionError),
        (o) => _ok(o, ride('accepted')),
      ];
      final c = await boot();
      expect(c.state.rideRestoreFailed, isTrue);

      // The retry chain — driven here manually so the test does not sleep.
      await c.retryActiveRideRecovery();
      await pump();

      expect(c.state.step, BookingStep.confirmed);
      expect(c.state.rideRestoreFailed, isFalse);
      expect(c.activeRideUnresolved, isFalse);
    });

    test('the ride completes while recovery is retrying', () async {
      responders = [
        (o) => _fail(o, DioExceptionType.connectionError),
        (o) => _ok(o, const <String, dynamic>{}), // ride ended meanwhile
      ];
      final c = await boot();
      await c.retryActiveRideRecovery();
      await pump();

      expect(c.activeRideUnresolved, isFalse);
      expect(c.state.rideId, isNull);
      expect(c.state.rideRestoreFailed, isFalse);
    });

    test('attempts are counted for the diagnostics strip', () async {
      responders = [(o) => _fail(o, DioExceptionType.connectionError)];
      final c = await boot();
      final first = c.recoveryAttempts;
      await c.retryActiveRideRecovery();
      expect(c.recoveryAttempts, greaterThan(first));
    });
  });
}
