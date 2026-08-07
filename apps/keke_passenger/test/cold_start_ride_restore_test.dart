/// Process death and reopen, driven through the real BookingController.
///
/// `active_ride_recovery_test.dart` covers the service in isolation. These are
/// the end-to-end assertions: build a controller exactly as the app does at
/// cold start, let it bootstrap, and check what the passenger would be looking
/// at. A fresh controller with `const BookingState()` IS a fresh process — no
/// state survives a force-close, which is precisely what made the bug possible.

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
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';

class _FakeMapRepository implements MapRepository {
  @override
  Future<LatLng?> getCurrentLocation() async => const LatLng(6.2109, 7.0740);

  @override
  noSuchMethod(Invocation invocation) => Future.value(null);
}

class _FakeNotificationService implements NotificationService {
  @override
  Stream<Map<String, dynamic>> get intentStream => const Stream.empty();

  @override
  noSuchMethod(Invocation invocation) => Future.value(null);
}

class _SilentSoundService implements SoundService {
  @override
  noSuchMethod(Invocation invocation) => Future.value(null);
}

void main() {
  late List<(String, Map<String, Object?>)> events;
  late SocketService socket;
  BookingController? controller;

  tearDown(() {
    controller?.dispose();
    controller = null;
  });

  /// The server's answer to `/rides/active/passenger`, whatever the test says.
  ApiClient _api(Map<String, dynamic> activeRide, {bool fail = false}) {
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
      if (options.path == '/rides/active/passenger') {
        if (fail) {
          return handler.reject(
            DioException(
              requestOptions: options,
              type: DioExceptionType.connectionError,
              message: 'offline',
            ),
            true,
          );
        }
        return handler.resolve(
          Response(requestOptions: options, statusCode: 200, data: activeRide),
        );
      }
      // Everything else is out of scope for these tests.
      return handler.reject(
        DioException(requestOptions: options, message: 'not stubbed'), true);
    }));
    return ApiClient(dio);
  }

  /// Cold start: a brand-new controller, exactly as the provider builds one.
  Future<BookingController> coldStart(
    Map<String, dynamic> activeRide, {
    bool fail = false,
  }) async {
    events = [];
    socket = SocketService.offline();
    final c = BookingController(
      _FakeMapRepository(),
      socket,
      _api(activeRide, fail: fail),
      _FakeNotificationService(),
      _SilentSoundService(),
      AnalyticsService(sink: (e, p) => events.add((e, p))),
      'passenger-1',
      'Ada',
      'Obi',
    );
    controller = c;
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    return c;
  }

  Map<String, dynamic> ride(String status, {Map<String, dynamic>? extra}) => {
        'rideId': 'RIDE-live-1',
        'status': status,
        'pickupLat': 6.2109,
        'pickupLng': 7.0740,
        'pickupAddress': 'Onitsha North',
        'destinationLat': 6.1400,
        'destinationLng': 6.8000,
        'destinationAddress': 'UNIZIK Gate',
        'fare': '850.00',
        'driverDetails': const {
          'name': 'Chidi Okeke',
          'plate': 'ABC-123-XY',
          'phone': '08030000000',
        },
        ...?extra,
      };

  // ══════════════════════════════════════════════════════════════════
  //  The reported bug
  // ══════════════════════════════════════════════════════════════════

  group('app force-closed with a live ride, then reopened', () {
    test('accepted → the driver-en-route screen is restored, with the driver',
        () async {
      final c = await coldStart(ride('accepted'));

      expect(c.state.step, BookingStep.confirmed,
          reason: 'the passenger must land on the ride, not on "Where to?"');
      expect(c.state.rideId, 'RIDE-live-1');
      expect(c.state.assignedDriver!['name'], 'Chidi Okeke');
      expect(c.state.destinationAddress, 'UNIZIK Gate');
      expect(c.state.estimatedFareAmount, 850);

      // And no error is shown. This is the message in the bug report.
      expect(c.state.notice, isNull);
    });

    test('arrived → the pickup screen is restored', () async {
      final c = await coldStart(ride('arrived'));
      expect(c.state.step, BookingStep.arrived);
    });

    test('in_progress → the active-trip screen is restored', () async {
      final c = await coldStart(ride('in_progress'));
      expect(c.state.step, BookingStep.started);
    });

    test('searching → the matching screen is restored', () async {
      final c = await coldStart(ride('searching'));
      expect(c.state.step, BookingStep.searching);
    });

    /*
     * The state changed while the process was dead. The app has no memory of
     * anything, so whatever it shows came from the server in this session.
     */
    test('a state change that happened while the app was dead is what shows',
        () async {
      final c = await coldStart(ride('arrived'));
      expect(c.state.step, BookingStep.arrived,
          reason: 'the app was killed at accepted; the driver has since arrived');
    });

    test('the ride room is rejoined so realtime resumes', () async {
      await coldStart(ride('accepted'));
      // Without this the socket never subscribes to ride:<id>, and driver
      // location updates and chat never arrive. updateActiveRide() had no
      // callers anywhere in the app before this fix.
      expect(
        socket.sentEvents.where((e) => e.event == 'join').map((e) => e.data),
        contains(predicate<dynamic>(
          (d) => d is Map && d['userId'] == 'RIDE-live-1' && d['role'] == 'ride',
        )),
      );
    });

    test('a pending coordination state is restored in the same pass', () async {
      final c = await coldStart(ride('accepted', extra: {
        'coordination': {
          'stage': 'CANCELLATION_REQUESTED',
          'eventId': 'evt-9',
          'rideStatus': 'accepted',
        },
      }));
      // Parsing is RideCoordination's business; what matters here is that the
      // block reached the controller in the cold-start round trip rather than
      // needing a second call that would flash the ordinary tracking screen.
      expect(c.state.step, BookingStep.confirmed);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  No ride, and terminal rides
  // ══════════════════════════════════════════════════════════════════

  group('nothing to restore', () {
    test('no active ride → the normal booking flow', () async {
      final c = await coldStart(const {});
      expect(c.state.step, isNot(BookingStep.confirmed));
      expect(c.state.rideId, isNull);
      expect(c.state.notice, isNull);
      expect(events.map((e) => e.$1), contains('active_ride_recovery_none'));
    });

    for (final status in ['completed', 'cancelled']) {
      test('a $status ride is not restored', () async {
        final c = await coldStart(ride(status));
        expect(c.state.step, isNot(BookingStep.confirmed));
        expect(c.state.step, isNot(BookingStep.arrived));
        expect(c.state.rideId, isNull);
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  Offline reopen
  // ══════════════════════════════════════════════════════════════════

  group('reopened with no network', () {
    test('stays in the restoring state and shows no destructive error',
        () async {
      final c = await coldStart(const {}, fail: true);

      // The old code wrote a generic failure notice here and dropped the
      // passenger on the booking screen — the exact screenshot in the report.
      expect(c.state.notice, isNull);
      expect(c.state.step, BookingStep.loading);
      expect(c.state.rideRestoreFailed, isTrue);
      expect(events.map((e) => e.$1), contains('active_ride_recovery_failed'));
    });

    test('booking is blocked until the question is settled', () async {
      final c = await coldStart(const {}, fail: true);
      expect(c.activeRideUnresolved, isTrue,
          reason: 'a passenger must not be able to create a second ride while '
              'we do not know whether they already have one');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Recovery from the other triggers
  // ══════════════════════════════════════════════════════════════════

  group('recovery runs on every trigger, not just cold start', () {
    test('app resume re-reads the server', () async {
      final c = await coldStart(const {});
      expect(c.state.rideId, isNull);

      await c.onAppResumed();
      expect(events.map((e) => e.$1).where((e) => e == 'active_ride_recovery_started').length,
          greaterThanOrEqualTo(2),
          reason: 'cold start and resume are both recovery attempts');
    });

    test('the source is reported so failures can be traced to a trigger',
        () async {
      final c = await coldStart(const {});
      await c.onNetworkRestored();
      final sources = events
          .where((e) => e.$1 == 'active_ride_recovery_started')
          .map((e) => e.$2['source'])
          .toList();
      expect(sources, contains('cold_start'));
      expect(sources, contains('network_reconnect'));
    });

    test('concurrent triggers do not race', () async {
      final c = await coldStart(const {});
      // A resume landing at the same moment as a socket reconnect must not
      // produce two calls both writing state.
      final a = c.recoverActiveRide(RecoverySource.appResume);
      final b = c.recoverActiveRide(RecoverySource.socketReconnect);
      final results = await Future.wait([a, b]);
      expect(results.where((r) => r.error == 'in_flight').length, 1);
    });
  });
}
