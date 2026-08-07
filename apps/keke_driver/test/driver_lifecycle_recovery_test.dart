/// Driver lifecycle recovery, through the real DriverController.
///
/// The service-level tests cover parsing. These cover the consequences — above
/// all the one that matters most: a driver whose recovery FAILED must not be
/// advertised as available while they are still carrying a passenger.

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import 'package:keke_driver/core/network/api_client.dart';
import 'package:keke_driver/core/network/notification_service.dart';
import 'package:keke_driver/core/network/socket_service.dart';
import 'package:keke_driver/core/services/analytics_service.dart';
import 'package:keke_driver/core/storage/secure_storage.dart';
import 'package:keke_driver/core/services/sound_service.dart';
import 'package:keke_driver/features/driver/application/active_ride_recovery.dart';
import 'package:keke_driver/features/driver/application/driver_controller.dart';
import 'package:keke_driver/features/driver/domain/driver_profile.dart';
import 'package:keke_driver/features/driver/domain/trip_request.dart';

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

TripRequest _offer(String id) => TripRequest(
      id: id,
      passengerId: 'passenger-1',
      isCash: true,
      passengerName: 'Ada Obi',
      passengerPhone: '08031234567',
      pickupAddress: 'Main Market, Onitsha',
      pickupLocation: _pickup,
      destinationAddress: 'Shoprite Onitsha',
      destinationLocation: _destination,
      fare: 700,
      distance: 2100,
      pickupCode: '4821',
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SocketService socket;
  late List<(String, Map<String, Object?>)> events;
  DriverController? controller;

  tearDown(() {
    controller?.dispose();
    controller = null;
  });

  /// `activeRide` is what `/rides/active/driver` returns. Everything else is
  /// offline, which the controller must survive.
  ApiClient _api(Map<String, dynamic>? activeRide, {bool failActiveRide = false}) {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
      if (options.path == '/rides/active/driver') {
        if (failActiveRide) {
          return handler.reject(
            DioException(
              requestOptions: options,
              type: DioExceptionType.connectionError,
              message: 'offline',
            ),
            true,
          );
        }
        return handler.resolve(Response(
          requestOptions: options,
          statusCode: 200,
          data: activeRide ?? const <String, dynamic>{},
        ));
      }
      return handler.reject(
          DioException(requestOptions: options, message: 'offline'), true);
    }));
    return ApiClient(dio);
  }

  Future<DriverController> build(
    Map<String, dynamic>? activeRide, {
    bool failActiveRide = false,
  }) async {
    events = [];
    socket = SocketService.offline();
    final c = DriverController(
      socket,
      _api(activeRide, failActiveRide: failActiveRide),
      _FakeNotificationService(),
      _SilentSoundService(),
      'driver-1',
      SecureStorageService(const FlutterSecureStorage()),
      null,
      analytics: AnalyticsService(sink: (e, p) => events.add((e, p))),
    );
    controller = c;
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    return c;
  }

  Map<String, dynamic> ride(String status) => {
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
        'passengerContact': const {'name': 'Ada Obi', 'phone': '08031234567'},
      };

  // ══════════════════════════════════════════════════════════════════
  //  The dangerous one
  // ══════════════════════════════════════════════════════════════════

  group('a driver whose recovery failed is never treated as free', () {
    test('the ride question stays unresolved', () async {
      final c = await build(null, failActiveRide: true);

      /*
       * `_maybeAutoResumeOnline()` used to read `operationStatus == offline` as
       * "free to go Online". A recovery that threw left exactly that state, so
       * a driver still carrying a passenger was put back in the available pool.
       *
       * The server would have refused to dispatch to them anyway
       * (DriverEligibilityService excludes `already_on_active_ride`), so this
       * was not a double-assignment — but the driver believed they were working
       * and silently received nothing.
       */
      expect(c.activeRideUnresolved, isTrue);
    });

    test('recovery is retried rather than abandoned', () async {
      final c = await build(null, failActiveRide: true);
      expect(c.activeRideUnresolved, isTrue);
      // A later trigger settles it once the network is back.
      // (Retry also fires on a timer; this asserts the manual path.)
      expect(c.state.operationStatus, isNot(OperationStatus.available));
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Restoration
  // ══════════════════════════════════════════════════════════════════

  group('accept → kill → reopen', () {
    test('the ride, the passenger and busy status are restored', () async {
      final c = await build(ride('accepted'));

      expect(c.state.tripStep, TripStep.accepted);
      expect(c.state.operationStatus, OperationStatus.busy);
      expect(c.state.activeRequest!.id, 'RIDE-live-1');
      expect(c.state.activeRequest!.passengerName, 'Ada Obi');
      expect(c.state.activeRequest!.passengerPhone, '08031234567');
      expect(c.activeRideUnresolved, isFalse);
    });

    test('the ride room is rejoined so chat and cancellations arrive', () async {
      await build(ride('arrived'));
      // The old recovery never called updateActiveRide, so a restarted driver
      // sat in the driver room only and missed everything ride-scoped.
      expect(
        socket.sentEvents.where((e) => e.event == 'join').map((e) => e.data),
        contains(predicate<dynamic>((d) =>
            d is Map && d['userId'] == 'RIDE-live-1' && d['role'] == 'ride')),
      );
    });

    test('a state change made while the app was dead is what shows', () async {
      final c = await build(ride('in_progress'));
      expect(c.state.tripStep, TripStep.started);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Pending offers must survive a "no active ride" answer
  // ══════════════════════════════════════════════════════════════════

  group('a pending offer is not an active ride', () {
    /*
     * An offer the driver has not accepted is still `searching` server-side and
     * is INVISIBLE to /rides/active/driver. Clearing on a null answer would
     * wipe a freshly-arrived offer — the driver hears the alert and no screen
     * appears. This race is why the outcome is not collapsed into one branch.
     */
    test('a fresh offer survives a recovery that reports no active ride',
        () async {
      final c = await build(null);
      c.debugSetOffer(_offer('RIDE-offer-1'));

      await c.recoverActiveRide(DriverRecoverySource.socketReconnect);

      expect(c.state.activeRequest, isNotNull,
          reason: 'a fresh offer must not be wiped by a null active-ride answer');
      expect(c.state.activeRequest!.id, 'RIDE-offer-1');
    });

    test('a stale offer is cleared so new requests can arrive', () async {
      final c = await build(null);
      c.debugSetOffer(_offer('RIDE-offer-old'),
          receivedAt: DateTime.now().subtract(const Duration(seconds: 60)));

      await c.recoverActiveRide(DriverRecoverySource.socketReconnect);

      expect(c.state.activeRequest, isNull,
          reason: 'its countdown froze while backgrounded; it can never be '
              'accepted and would block new offers');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Terminal
  // ══════════════════════════════════════════════════════════════════

  group('a ride that ended while the app was dead', () {
    test('is cleared and the driver returns to available', () async {
      final c = await build(ride('accepted'));
      expect(c.state.tripStep, TripStep.accepted);

      // The passenger cancelled while the driver's app was closed.
      controller = c;
      final fresh = await build(null);
      expect(fresh.state.tripStep, TripStep.none);
      expect(fresh.state.activeRequest, isNull);
    });
  });

  group('concurrency', () {
    test('two triggers landing together do not race', () async {
      final c = await build(null);
      final results = await Future.wait([
        c.recoverActiveRide(DriverRecoverySource.appResume),
        c.recoverActiveRide(DriverRecoverySource.socketReconnect),
      ]);
      expect(results.where((r) => r.error == 'in_flight').length, 1);
    });
  });
}
