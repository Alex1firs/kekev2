import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:keke_driver/core/network/api_client.dart';
import 'package:keke_driver/core/network/notification_service.dart';
import 'package:keke_driver/core/network/socket_service.dart';
import 'package:keke_driver/core/services/analytics_service.dart';
import 'package:keke_driver/core/services/sound_service.dart';
import 'package:keke_driver/core/storage/secure_storage.dart';
import 'package:keke_driver/features/driver/application/driver_controller.dart';
import 'package:keke_driver/features/driver/domain/driver_profile.dart';
import 'package:keke_driver/features/driver/domain/trip_request.dart';

/// "Call passenger" on a ride that arrived by hand.
///
/// The production failure: Operations assigned a driver, the assignment
/// succeeded, the trip showed on the driver's phone, and Call passenger said
/// the number was unavailable.
///
/// The cause was in this file's subject. The call button read
/// `activeRequest.passengerPhone`, which is populated by exactly two things —
/// the dispatch offer payload, and active-ride recovery. A manual assignment
/// goes through neither at the moment it happens, so the field was empty and
/// the button dead-ended. `/rides/{id}/contact` is the server's authorised
/// answer to the same question and nothing was calling it.
///
/// These tests are about the four outcomes being DISTINGUISHED. Collapsing
/// them into null is what made a data state ("this passenger has no number")
/// and a fault ("we could not ask") look identical to the person standing at
/// the pickup point.

const _pickup = LatLng(6.1631, 6.7872);
const _destination = LatLng(6.1584, 6.7837);

class _FakeNotificationService extends NotificationService {
  _FakeNotificationService() : super(null, 'driver');

  @override
  Future<void> handleInitialMessage() async {}

  @override
  Future<void> initialize() async {}

  @override
  Future<void> registerDeviceToken({int attempt = 1}) async {}
}

class _SilentSoundService extends SoundService {
  @override
  Future<void> playRequestSound() async {}

  @override
  Future<void> stop() async {}
}

TripRequest _request(String rideId, {String? phone}) => TripRequest(
      id: rideId,
      passengerId: 'passenger-9',
      isCash: true,
      passengerName: 'Ada',
      passengerPhone: phone,
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

  const rideId = 'RIDE-1785000000000';

  late DriverController controller;
  late List<String> contactCalls;

  /// Serves only `/rides/{id}/contact`; everything else fails, which keeps the
  /// controller off the network without stubbing the whole API.
  ApiClient stubApi({
    int status = 200,
    Map<String, dynamic>? body,
    bool network = true,
  }) {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        if (RegExp(r'^/rides/.+/contact$').hasMatch(options.path)) {
          contactCalls.add(options.path);
          if (!network) {
            return handler.reject(
                DioException(
                    requestOptions: options,
                    type: DioExceptionType.connectionTimeout),
                true);
          }
          if (status >= 400) {
            return handler.reject(
                DioException(
                  requestOptions: options,
                  response: Response(
                      requestOptions: options, statusCode: status, data: body),
                  type: DioExceptionType.badResponse,
                ),
                true);
          }
          return handler.resolve(Response(
              requestOptions: options, statusCode: status, data: body));
        }
        return handler.reject(
            DioException(requestOptions: options, message: 'offline'), true);
      },
    ));
    return ApiClient(dio);
  }

  Future<void> arrange(ApiClient api, {TripRequest? ride}) async {
    contactCalls = [];
    controller = DriverController(
      SocketService.offline(),
      api,
      _FakeNotificationService(),
      _SilentSoundService(),
      'driver-1',
      SecureStorageService(const FlutterSecureStorage()),
      null,
      analytics: AnalyticsService(sink: (_, __) {}),
    );
    await Future<void>.delayed(Duration.zero);
    if (ride != null) {
      controller.debugSetActiveRide(ride, TripStep.accepted);
      await Future<void>.delayed(Duration.zero);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  The ride carried a number already
  // ══════════════════════════════════════════════════════════════════

  test('an automatically dispatched ride dials without asking the server',
      () async {
    // The offer payload carried the number, so the common path costs nothing.
    await arrange(stubApi(), ride: _request(rideId, phone: '08031234567'));

    final r = await controller.resolvePassengerPhone();

    expect(r.dialable, isTrue);
    expect(r.phone, '08031234567');
    expect(contactCalls, isEmpty);
  });

  // ══════════════════════════════════════════════════════════════════
  //  The ride arrived without one — the Operations case
  // ══════════════════════════════════════════════════════════════════

  test('a manually assigned ride fetches the number and can then dial',
      () async {
    // No phone on the ride: exactly the state an Operations assignment leaves.
    await arrange(
      stubApi(body: {
        'firstName': 'Ada',
        'phone': '08031234567',
        'dialable': true,
      }),
      ride: _request(rideId),
    );

    final r = await controller.resolvePassengerPhone();

    expect(r.dialable, isTrue);
    expect(r.phone, '08031234567');
    expect(contactCalls, ['/rides/$rideId/contact']);
  });

  test('the fetched number is cached, so a second tap does not ask again',
      () async {
    await arrange(
      stubApi(body: {
        'firstName': 'Ada',
        'phone': '08031234567',
        'dialable': true,
      }),
      ride: _request(rideId),
    );

    await controller.resolvePassengerPhone();
    final again = await controller.resolvePassengerPhone();

    expect(again.phone, '08031234567');
    expect(contactCalls, hasLength(1));
    // And the ride itself now carries it, so the HUD renders consistently.
    expect(controller.state.activeRequest!.passengerPhone, '08031234567');
  });

  // ══════════════════════════════════════════════════════════════════
  //  The four outcomes stay four outcomes
  // ══════════════════════════════════════════════════════════════════

  test('a passenger with no number on file is reported as such, not as a fault',
      () async {
    await arrange(
      stubApi(body: {'firstName': 'Ada', 'phone': null, 'dialable': false}),
      ride: _request(rideId),
    );

    final r = await controller.resolvePassengerPhone();

    expect(r.outcome, PassengerContactOutcome.noNumber);
    expect(r.dialable, isFalse);
    expect(r.message, contains('no phone number on file'));
  });

  test('a driver released from the ride is told that, not "unavailable"',
      () async {
    // The server answers 404 for both "not yours" and "no such ride" — a driver
    // probing ride ids must not learn which ones exist.
    await arrange(stubApi(status: 404), ride: _request(rideId));

    final r = await controller.resolvePassengerPhone();

    expect(r.outcome, PassengerContactOutcome.notAllowed);
    expect(r.message, contains('no longer assigned'));
  });

  test('403 is treated the same way — the ride is not ours to call', () async {
    await arrange(stubApi(status: 403), ride: _request(rideId));
    final r = await controller.resolvePassengerPhone();
    expect(r.outcome, PassengerContactOutcome.notAllowed);
  });

  test('a network failure never claims the passenger has no number', () async {
    /*
     * The distinction that matters most. "We could not ask" must never be
     * rendered as "there is no number" — the driver would stop trying, on a
     * ride where the passenger is reachable and waiting.
     */
    await arrange(stubApi(network: false), ride: _request(rideId));

    final r = await controller.resolvePassengerPhone();

    expect(r.outcome, PassengerContactOutcome.failed);
    expect(r.message, contains('try again'));
    expect(r.message, isNot(contains('no phone number')));
  });

  test('no active ride asks nothing and says so', () async {
    await arrange(stubApi());

    final r = await controller.resolvePassengerPhone();

    expect(r.outcome, PassengerContactOutcome.noRide);
    expect(contactCalls, isEmpty);
  });
}
