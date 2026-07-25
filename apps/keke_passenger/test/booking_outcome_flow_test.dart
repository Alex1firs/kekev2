import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:keke_passenger/core/network/notification_service.dart';
import 'package:keke_passenger/core/network/socket_service.dart';
import 'package:keke_passenger/core/services/analytics_service.dart';
import 'package:keke_passenger/core/services/sound_service.dart';
import 'package:keke_passenger/features/passenger/application/booking_controller.dart';
import 'package:keke_passenger/features/passenger/data/map_repository.dart';
import 'package:keke_passenger/features/passenger/domain/booking_notice.dart';
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';

/// Onitsha — deliberately not Awka, mirroring the reported case.
const _pickup = LatLng(6.1631, 6.7872);
const _destination = LatLng(6.1584, 6.7837);

class _FakeMapRepository extends MapRepository {
  _FakeMapRepository() : super(Dio());

  @override
  Future<LatLng?> getCurrentLocation() async => _pickup;

  @override
  Future<String?> reverseGeocode(LatLng target) async => 'Main Market, Onitsha';

  @override
  Future<Map<String, dynamic>> calculateRouteAndFare(
      LatLng origin, LatLng destination) async {
    return {
      'distance': '2.1 km',
      'time': '9 mins',
      'fare': 700,
      'polyline': <LatLng>[origin, destination],
    };
  }

  @override
  Future<List<LatLng>> getRoutePath(LatLng origin, LatLng destination) async =>
      const [];
}

class _FakeNotificationService extends NotificationService {
  _FakeNotificationService() : super(null, 'passenger');

  // Firebase isn't available under `flutter test`.
  @override
  Future<void> handleInitialMessage() async {}
}

class _SilentSoundService extends SoundService {
  @override
  Future<void> playAlert() async {}
}

void main() {
  late SocketService socket;
  late BookingController controller;
  late List<(String, Map<String, Object?>)> events;

  /// Builds a controller sitting on the fare screen with a priced route, i.e.
  /// exactly where a passenger is when they tap "Request Keke".
  Future<void> arrangeAtFareScreen({bool connected = true}) async {
    socket = SocketService.offline(connected: connected);
    events = [];
    controller = BookingController(
      _FakeMapRepository(),
      socket,
      null, // no ApiClient — skips active-ride recovery and nearby polling
      _FakeNotificationService(),
      _SilentSoundService(),
      AnalyticsService(sink: (e, p) => events.add((e, p))),
      'passenger-1',
      'Ada',
      'Obi',
    );
    // let _initializeMap() settle
    await Future<void>.delayed(Duration.zero);
    controller.setDestination('Shoprite Onitsha', _destination);
    await Future<void>.delayed(Duration.zero);
  }

  tearDown(() => controller.dispose());

  group('search lifecycle', () {
    test('requesting a ride enters searching on round 1 and logs the start',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();

      expect(controller.state.step, BookingStep.searching);
      expect(controller.state.searchRound, 1);
      expect(controller.state.searchAttempts, 1);
      expect(controller.state.notice, isNull);
      expect(SearchingCopy.of(controller.state.searchRound).primary,
          'Finding a Keke near you…');

      // The existing request flow is untouched.
      expect(socket.sentEvents.map((e) => e.event),
          containsAllInOrder(['join', 'ride:request']));
      final payload =
          socket.sentEvents.last.data as Map<String, dynamic>;
      expect(payload['pickupLat'], _pickup.latitude);
      expect(payload['fare'], 700);

      expect(events.map((e) => e.$1), contains('passenger_ride_search_started'));
    });

    test('Search Again re-requests and switches to the second-round copy',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
        'dispatchResult': 'drivers_rung_none_accepted',
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.step, BookingStep.previewEstimate);

      controller.searchAgain();

      expect(controller.state.step, BookingStep.searching);
      expect(controller.state.searchRound, 2);
      expect(controller.state.searchAttempts, 2);
      expect(controller.state.notice, isNull,
          reason: 'the notice must clear when a new search starts');
      expect(SearchingCopy.of(controller.state.searchRound).primary,
          'Still searching nearby…');
      expect(
          socket.sentEvents.where((e) => e.event == 'ride:request').length, 2);
    });
  });

  group('ride:failed maps to the right availability outcome', () {
    test('nobody accepted → busy-drivers notice, informational, on fare screen',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
        'dispatchResult': 'drivers_rung_none_accepted',
        'message': 'No drivers available nearby',
      });
      await Future<void>.delayed(Duration.zero);

      final notice = controller.state.notice!;
      expect(notice.outcome, RideOutcome.noDriverAccepted);
      expect(notice.tone, RideOutcomeTone.info);
      expect(notice.title, 'Drivers are currently busy');
      expect(controller.state.step, BookingStep.previewEstimate);
      expect(controller.state.rideId, isNull);
      // The old red message must not resurface from the server payload.
      expect(notice.body, isNot(contains('No drivers available')));
    });

    test('no eligible driver → its own distinct notice', () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_ELIGIBLE_DRIVER',
        'dispatchResult': 'no_eligible_drivers',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.notice!.outcome, RideOutcome.noEligibleDriver);
      expect(controller.state.notice!.title, 'No Keke nearby right now');
    });

    test('server dispatch timeout → expired, not a driver shortage', () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'REQUEST_EXPIRED',
        'dispatchResult': 'dispatch_timeout',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.notice!.outcome, RideOutcome.requestExpired);
    });

    test('a legacy server with no code still produces a usable notice',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'message': 'No drivers available nearby',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.notice!.outcome, RideOutcome.noDriverAccepted);
      expect(controller.state.notice!.tone, RideOutcomeTone.info);
    });

    test('the outcome event carries id, code, dispatch result and attempts',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      final rideId = controller.state.rideId;
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
        'dispatchResult': 'drivers_rung_none_accepted',
      });
      await Future<void>.delayed(Duration.zero);

      final outcome =
          events.lastWhere((e) => e.$1 == 'passenger_ride_outcome').$2;
      expect(outcome['rideId'], rideId);
      expect(outcome['outcomeCode'], 'NO_DRIVER_ACCEPTED');
      expect(outcome['dispatchResult'], 'drivers_rung_none_accepted');
      expect(outcome['searchAttempts'], 1);
      expect(outcome['timestamp'], isA<String>());
    });
  });

  group('real failures stay errors', () {
    test('no connectivity blocks the request with an error-toned notice',
        () async {
      await arrangeAtFareScreen(connected: false);
      controller.requestRide();

      final notice = controller.state.notice!;
      expect(notice.outcome, RideOutcome.networkFailed);
      expect(notice.tone, RideOutcomeTone.error);
      // Never left the device, so we never pretended to search.
      expect(controller.state.step, BookingStep.previewEstimate);
      expect(socket.sentEvents.where((e) => e.event == 'ride:request'), isEmpty);
    });

    test('a server error mid-search ends the search as a server failure',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:error',
        'code': 'INTERNAL_ERROR',
        'message': 'Failed to create ride. Please try again.',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.notice!.outcome, RideOutcome.serverFailed);
      expect(controller.state.notice!.tone, RideOutcomeTone.error);
      expect(controller.state.step, BookingStep.previewEstimate);
    });
  });

  group('active ride protection', () {
    test('ACTIVE_RIDE_EXISTS ends the search immediately instead of spinning',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      expect(controller.state.step, BookingStep.searching);

      socket.injectEvent({
        'event': 'ride:error',
        'code': 'ACTIVE_RIDE_EXISTS',
        'message': 'You already have an active ride in progress.',
      });
      await Future<void>.delayed(Duration.zero);

      // Previously this event was ignored and the passenger watched the search
      // animation for 90s before being told "no drivers available".
      expect(controller.state.step, BookingStep.previewEstimate);
      final notice = controller.state.notice!;
      expect(notice.outcome, RideOutcome.activeRideExists);
      expect(notice.title, 'You already have a ride in progress');
      expect(notice.canSearchAgain, isFalse,
          reason: 'retrying cannot succeed while a ride is live');
      expect(notice.tone, RideOutcomeTone.info,
          reason: 'a valid guard is not an app error');
      expect(events.map((e) => e.$2['outcomeCode']),
          contains('ACTIVE_RIDE_EXISTS'));
    });

    test('an error outside a search leaves the current step alone', () async {
      await arrangeAtFareScreen();
      socket.injectEvent({
        'event': 'ride:error',
        'code': 'ACTIVE_RIDE_EXISTS',
        'message': 'You already have an active ride in progress.',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.step, BookingStep.previewEstimate);
      expect(controller.state.notice!.outcome, RideOutcome.activeRideExists);
    });
  });

  group('assignment clears the notice', () {
    test('a driver accepting wipes any leftover outcome notice', () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.notice, isNotNull);

      controller.searchAgain();
      socket.injectEvent({
        'event': 'ride:assigned',
        'driverDetails': {'firstName': 'Chidi'},
        'pickupCode': 'AB12',
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.step, BookingStep.confirmed);
      expect(controller.state.notice, isNull);
    });
  });
}
