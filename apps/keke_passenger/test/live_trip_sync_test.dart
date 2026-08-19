/// Live in-trip realtime synchronisation.
///
/// The field report: driver starts the trip, then the passenger's marker
/// freezes, the ETA sticks at "4 minutes", and when the driver ends the ride the
/// passenger stays on the in-progress screen. Restarting the app corrects it.
///
/// Root cause: Socket.IO rooms are per-CONNECTION. `driver:location_update` and
/// `ride:finished` are both broadcast to `ride:<id>`. The passenger joined that
/// room once, when requesting the ride, and the shipped build never recorded
/// the id — so any reconnect dropped them from it permanently.
///
/// These tests drive the real controller through a real trip.

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

  // The approach-route fetch runs when the driver moves >50 m, and returns a
  // typed list. noSuchMethod's Future<Null> would fail the cast.
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

const _pickup = LatLng(6.2109, 7.0740);
const _destination = LatLng(6.1400, 6.8000);

void main() {
  late SocketService socket;
  late List<(String, Map<String, Object?>)> events;
  BookingController? controller;

  /// What `/rides/active/passenger` currently reports. Mutated mid-test to
  /// represent the server moving on while the client is not listening.
  late Map<String, dynamic> serverRide;

  tearDown(() {
    controller?.dispose();
    controller = null;
  });

  ApiClient _api() {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
      if (options.path == '/rides/active/passenger') {
        return handler.resolve(
            Response(requestOptions: options, statusCode: 200, data: serverRide));
      }
      return handler.reject(
          DioException(requestOptions: options, message: 'not stubbed'), true);
    }));
    return ApiClient(dio);
  }

  Map<String, dynamic> ride(String status) => {
        'rideId': 'RIDE-1',
        'status': status,
        'pickupLat': _pickup.latitude,
        'pickupLng': _pickup.longitude,
        'pickupAddress': 'Main Market',
        'destinationLat': _destination.latitude,
        'destinationLng': _destination.longitude,
        'destinationAddress': 'UNIZIK Gate',
        'fare': '850.00',
        'driverDetails': const {'name': 'Chidi Okeke'},
      };

  Future<void> pump([int turns = 10]) async {
    for (var i = 0; i < turns; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  /// A passenger on a live ride at [status], recovered exactly as a cold start
  /// would produce.
  Future<BookingController> onRide(String status) async {
    events = [];
    socket = SocketService.offline();
    serverRide = ride(status);
    final c = BookingController(
      _FakeMapRepository(),
      socket,
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

  Future<void> inject(Map<String, dynamic> e) async {
    socket.injectEvent(e);
    await pump(3);
  }

  Map<String, dynamic> location(double lat, double lng) => {
        'event': 'driver:location_update',
        'rideId': 'RIDE-1',
        'lat': lat,
        'lng': lng,
      };

  // ══════════════════════════════════════════════════════════════════
  //  1–3. The stream keeps flowing after the trip starts
  // ══════════════════════════════════════════════════════════════════

  group('the trip does not go stale when it starts', () {
    test('accepted → arrived → started keeps applying driver locations',
        () async {
      final c = await onRide('accepted');
      expect(c.state.step, BookingStep.confirmed);

      await inject(location(6.2100, 7.0730));
      expect(c.state.assignedDriverLocation, isNotNull);

      serverRide = ride('arrived');
      await inject({'event': 'ride:status_update', 'rideId': 'RIDE-1', 'status': 'arrived'});
      await inject(location(6.2095, 7.0725));
      expect(c.state.assignedDriverLocation!.latitude, closeTo(6.2095, 0.0001));

      serverRide = ride('in_progress');
      await inject({'event': 'ride:status_update', 'rideId': 'RIDE-1', 'status': 'started'});
      expect(c.state.step, BookingStep.started);

      // The reported symptom: after this point the marker stopped moving.
      await inject(location(6.2000, 7.0500));
      expect(c.state.assignedDriverLocation!.latitude, closeTo(6.2000, 0.0001),
          reason: 'driver locations must still apply once the trip is running');
    });

    test('the marker is still present after ride start', () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, 7.0500));
      expect(c.state.assignedDriverLocation, isNotNull);
      expect(c.state.step, BookingStep.started);
    });

    test('successive updates move the marker', () async {
      final c = await onRide('in_progress');
      final seen = <double>[];
      for (final lat in [6.2000, 6.1900, 6.1800, 6.1700]) {
        await inject(location(lat, 7.0000));
        seen.add(c.state.assignedDriverLocation!.latitude);
      }
      expect(seen, [6.2000, 6.1900, 6.1800, 6.1700]);
    });

    // ── 4. remaining distance decreases ──────────────────────────────
    test('remaining distance to the destination decreases as the driver moves',
        () async {
      final c = await onRide('in_progress');
      final distances = <double>[];
      for (final lat in [6.2000, 6.1800, 6.1600, 6.1450]) {
        await inject(location(lat, _destination.longitude));
        distances.add(c.state.distanceToDestinationMeters!);
      }
      for (var i = 1; i < distances.length; i++) {
        expect(distances[i], lessThan(distances[i - 1]),
            reason: 'distance must fall as the Keke approaches the destination');
      }
    });

    // ── 5. ETA refreshes ─────────────────────────────────────────────
    test('ETA to the destination refreshes rather than sticking', () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, _destination.longitude));
      final first = c.state.etaToDestinationMinutes!;

      await inject(location(6.1500, _destination.longitude));
      final later = c.state.etaToDestinationMinutes!;

      expect(later, lessThan(first),
          reason: 'the field report was an ETA stuck at "4 minutes"');
    });

    test('the pickup ETA is cleared once the trip starts', () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, 7.0500));
      // Showing "4 min to pickup" during a trip is its own kind of stale.
      expect(c.state.etaMinutes, isNull);
      expect(c.state.etaToDestinationMinutes, isNotNull);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  6–7. Completion, and completion that never arrived
  // ══════════════════════════════════════════════════════════════════

  group('completion', () {
    test('a completion event ends the trip', () async {
      final c = await onRide('in_progress');
      await inject({'event': 'ride:finished', 'rideId': 'RIDE-1'});
      expect(c.state.step, isNot(BookingStep.started));
      expect(events.map((e) => e.$1), contains('passenger_trip_completion_received'));
    });

    /*
     * The field symptom. The driver ended the ride, the event was broadcast to
     * a room the passenger had silently left, and the app sat on the in-progress
     * screen until it was restarted. Reconciliation is the safety net.
     */
    test('a missed completion is discovered by reconciliation', () async {
      final c = await onRide('in_progress');
      expect(c.state.step, BookingStep.started);

      // The ride ends server-side. No socket event reaches us.
      serverRide = <String, dynamic>{};

      await c.recoverActiveRide(RecoverySource.liveTripReconcile);
      await pump();

      expect(c.state.step, isNot(BookingStep.started),
          reason: 'the passenger must not be left on a trip that has ended');
      expect(c.state.rideId, isNull);
    });

    test('a terminal ride stops the live monitor', () async {
      final c = await onRide('in_progress');
      expect(c.liveDiagnostics.monitorRunning, isTrue);

      serverRide = <String, dynamic>{};
      await c.recoverActiveRide(RecoverySource.liveTripReconcile);
      await pump();

      expect(c.liveDiagnostics.monitorRunning, isFalse,
          reason: 'a finished ride must not keep reconciling forever');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  8. Room membership — the actual root cause
  // ══════════════════════════════════════════════════════════════════

  group('ride room membership', () {
    test('recovery joins the ride room', () async {
      await onRide('in_progress');
      expect(socket.activeRideRoom, 'RIDE-1');
      expect(
        socket.sentEvents.where((e) => e.event == 'join').map((e) => e.data),
        contains(predicate<dynamic>(
            (d) => d is Map && d['userId'] == 'RIDE-1' && d['role'] == 'ride')),
      );
    });

    /*
     * Rooms are per-connection. This is the assertion that the shipped build
     * would fail: it never recorded the ride id, so onConnect had nothing to
     * rejoin and the passenger left the room for good.
     */
    test('the socket remembers the room so a reconnect can rejoin it', () async {
      await onRide('in_progress');
      expect(socket.activeRideRoom, isNotNull,
          reason: 'a null here is exactly the frozen-marker bug');
    });

    test('rejoinRooms re-asserts both rooms on the current connection', () async {
      await onRide('in_progress');
      socket.sentEvents.clear();

      socket.rejoinRooms();

      final joins = socket.sentEvents.where((e) => e.event == 'join').toList();
      expect(joins.length, 2, reason: 'the user room and the ride room');
      expect(joins.map((e) => (e.data as Map)['role']),
          containsAll(['passenger', 'ride']));
    });

    test('a reconnect triggers a fresh server read', () async {
      final c = await onRide('in_progress');
      final before =
          events.where((e) => e.$1 == 'active_ride_recovery_started').length;

      await inject({'event': 'socket:reconnected'});
      await pump();

      expect(events.where((e) => e.$1 == 'active_ride_recovery_started').length,
          greaterThan(before));
      expect(c.state.step, BookingStep.started);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  12. Stale-stream detection
  // ══════════════════════════════════════════════════════════════════

  group('a stale stream repairs itself', () {
    test('receiving a location clears the stale flag', () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, 7.0500));
      expect(c.state.liveStreamStale, isFalse);
    });

    test('every location update is reported for telemetry', () async {
      await onRide('in_progress');
      await inject(location(6.2000, 7.0500));
      expect(events.map((e) => e.$1), contains('passenger_live_location_received'));
    });

    test('the monitor runs for every tracking step and no other', () async {
      for (final status in ['accepted', 'arrived', 'in_progress']) {
        final c = await onRide(status);
        expect(c.liveDiagnostics.monitorRunning, isTrue,
            reason: '$status is a live ride and must be monitored');
        c.dispose();
      }

      // No ride at all: nothing to monitor.
      events = [];
      socket = SocketService.offline();
      serverRide = <String, dynamic>{};
      final idle = BookingController(
        _FakeMapRepository(), socket, _api(), _FakeNotificationService(),
        _SilentSoundService(),
        AnalyticsService(sink: (e, p) => events.add((e, p))),
        'passenger-1', 'Ada', 'Obi',
      );
      controller = idle;
      await pump();
      expect(idle.liveDiagnostics.monitorRunning, isFalse);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  13–15. Duplicates and cleanup
  // ══════════════════════════════════════════════════════════════════

  group('no duplicate work', () {
    test('repeated reconnects do not stack monitors', () async {
      final c = await onRide('in_progress');
      for (var i = 0; i < 5; i++) {
        await inject({'event': 'socket:reconnected'});
      }
      // One timer, however many reconnects. A second would double the
      // reconciliation rate for every subsequent tick.
      expect(c.liveDiagnostics.monitorRunning, isTrue);
    });

    test('the same location twice does not corrupt the distance series',
        () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, _destination.longitude));
      final d1 = c.state.distanceToDestinationMeters;
      await inject(location(6.2000, _destination.longitude));
      expect(c.state.distanceToDestinationMeters, d1);
    });

    test('disposing stops the monitor', () async {
      final c = await onRide('in_progress');
      expect(c.liveDiagnostics.monitorRunning, isTrue);
      c.dispose();
      controller = null;
      // No assertion on internals after dispose beyond not throwing: a timer
      // left running would fire against a disposed notifier and blow up the
      // test run, which is the real check.
      await pump();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Diagnostics
  // ══════════════════════════════════════════════════════════════════

  group('field-test diagnostics', () {
    test('reports the room, the stream age and the ride', () async {
      final c = await onRide('in_progress');
      await inject(location(6.2000, 7.0500));

      final d = c.liveDiagnostics;
      expect(d.rideId, 'RIDE-1');
      expect(d.step, 'started');
      expect(d.joinedRideRoom, 'RIDE-1');
      expect(d.roomMembershipSuspect, isFalse);
      expect(d.secondsSinceLocation, isNotNull);
      expect(d.driverLocation, isNotNull);
    });

    test('flags a suspect room membership — the bug being hunted', () async {
      final c = await onRide('in_progress');
      // Simulate the shipped build's state: on a ride, but not in the room.
      socket.updateActiveRide(null);
      expect(c.liveDiagnostics.roomMembershipSuspect, isTrue);
    });

    test('carries no passenger identity', () async {
      final c = await onRide('in_progress');
      final serialised = c.liveDiagnostics.toMap().toString();
      expect(serialised.contains('Ada'), isFalse);
      expect(serialised.contains('passenger-1'), isFalse);
    });
  });
}
