import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:keke_passenger/core/network/api_client.dart';
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

/// Captures the nearby-Keke feed requests the controller makes, and lets a test
/// decide what the server returns — including failing, to prove markers age out
/// rather than lingering when the connection drops.
class _FakeNearbyApi {
  final List<String> requestedRideIds = [];
  List<Map<String, dynamic>> markers = [];
  int? eligibleCount;
  bool shouldFail = false;

  Map<String, dynamic> respond(String rideId) => {
        'rideId': rideId,
        'dispatchRound': 1,
        'searchRadiusKm': 2.0,
        'markers': markers,
        'eligibleCount': eligibleCount ?? markers.length,
        'approximateRadiusMeters': 120,
        'refreshAfterMs': 8000,
      };
}

Map<String, dynamic> _marker(String key) => {
      'key': key,
      'lat': 6.21,
      'lng': 7.05,
      'expiresAt':
          DateTime.now().add(const Duration(seconds: 20)).millisecondsSinceEpoch,
    };

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

  late _FakeNearbyApi nearbyApi;

  /// ApiClient whose only live route is the nearby-Keke feed. Every other call
  /// (active-ride recovery, browse polling) fails fast, which is what the
  /// no-ApiClient variant used to achieve by passing null.
  ApiClient _stubApiClient(_FakeNearbyApi api) {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        // No active ride to recover — the normal case for a fresh booking.
        if (options.path == '/rides/active/passenger') {
          return handler.resolve(Response(
            requestOptions: options,
            statusCode: 200,
            data: const <String, dynamic>{},
          ));
        }
        final match = RegExp(r'^/rides/(.+)/nearby-kekes$').firstMatch(options.path);
        if (match != null && !api.shouldFail) {
          api.requestedRideIds.add(match.group(1)!);
          return handler.resolve(Response(
            requestOptions: options,
            statusCode: 200,
            data: api.respond(match.group(1)!),
          ));
        }
        if (match != null) api.requestedRideIds.add(match.group(1)!);
        return handler.reject(
          DioException(requestOptions: options, message: 'offline'),
          true,
        );
      },
    ));
    return ApiClient(dio);
  }

  /// Builds a controller sitting on the fare screen with a priced route, i.e.
  /// exactly where a passenger is when they tap "Request Keke".
  Future<void> arrangeAtFareScreen({bool connected = true}) async {
    socket = SocketService.offline(connected: connected);
    events = [];
    nearbyApi = _FakeNearbyApi();
    controller = BookingController(
      _FakeMapRepository(),
      socket,
      _stubApiClient(nearbyApi),
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

  group('server-driven redispatch rounds', () {
    test('ride:dispatch_round switches to round-two copy without re-requesting',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      final rideId = controller.state.rideId;
      expect(controller.state.searchRound, 1);

      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': rideId,
        'dispatchRound': 2,
        'totalRounds': 2,
        'reason': 'auto_redispatch',
        'offersSentCount': 1,
        'explicitRejectCount': 0,
      });
      await Future<void>.delayed(Duration.zero);

      // Copy advances…
      expect(controller.state.step, BookingStep.searching);
      expect(controller.state.searchRound, 2);
      expect(SearchingCopy.of(controller.state.searchRound).primary,
          'Still searching nearby…');
      expect(SearchingCopy.of(controller.state.searchRound).supporting,
          'We\'re checking again for an available Keke driver.');

      // …but the ride is untouched: same id, no second booking request, and no
      // extra search attempt counted against the passenger.
      expect(controller.state.rideId, rideId);
      expect(controller.state.searchAttempts, 1);
      expect(
          socket.sentEvents.where((e) => e.event == 'ride:request').length, 1);
    });

    test('a stale or duplicate round event cannot move the copy backwards',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.searchRound, 2);

      // Re-delivered after a socket heal, and a bogus round 1.
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 1,
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.searchRound, 2);
      expect(
          events.where((e) => e.$1 == 'passenger_dispatch_round').length, 1,
          reason: 'the duplicate must not be logged twice');
    });

    test('a round event with no round number is ignored', () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({'event': 'ride:dispatch_round', 'rideId': 'x'});
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.searchRound, 1);
      expect(controller.state.step, BookingStep.searching);
    });

    test('an outcome after round two reports the round and server counts',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      await Future<void>.delayed(Duration.zero);

      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
        'dispatchResult': 'offers_delivered_none_accepted',
        'dispatchRound': 2,
        'roundsRun': 2,
        'eligibleDriverCount': 3,
        'reservedDriverCount': 3,
        'offersSentCount': 2,
        'explicitRejectCount': 1,
        'expiredOfferCount': 1,
        'deliveryFailureCount': 1,
        'acknowledgedCount': 2,
      });
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.notice!.outcome, RideOutcome.noDriverAccepted);
      final outcome =
          events.lastWhere((e) => e.$1 == 'passenger_ride_outcome').$2;
      expect(outcome['searchRound'], 2);
      expect(outcome['offersSentCount'], 2);
      expect(outcome['explicitRejectCount'], 1);
      expect(outcome['expiredOfferCount'], 1);
      expect(outcome['deliveryFailureCount'], 1);
      expect(outcome['acknowledgedCount'], 2);
      expect(outcome['eligibleDriverCount'], 3);
    });

    test('an older server sending no counts still yields a clean outcome',
        () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:failed',
        'code': 'NO_DRIVER_ACCEPTED',
        'message': 'No drivers available nearby',
      });
      await Future<void>.delayed(Duration.zero);

      final outcome =
          events.lastWhere((e) => e.$1 == 'passenger_ride_outcome').$2;
      expect(outcome['outcomeCode'], 'NO_DRIVER_ACCEPTED');
      // Absent fields are omitted rather than logged as nulls.
      expect(outcome.containsKey('offersSentCount'), isFalse);
      expect(controller.state.notice!.title, 'Drivers are currently busy');
    });

    test('Search Again after two server rounds is still attempt two', () async {
      await arrangeAtFareScreen();
      controller.requestRide();
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      await Future<void>.delayed(Duration.zero);
      socket.injectEvent({'event': 'ride:failed', 'code': 'NO_DRIVER_ACCEPTED'});
      await Future<void>.delayed(Duration.zero);

      final firstRideId = controller.state.rideId;
      controller.searchAgain();

      // A manual retry is a NEW ride request (and a new ride id) — distinct from
      // the server's automatic second round on the same ride.
      expect(controller.state.searchAttempts, 2);
      expect(controller.state.rideId, isNot(firstRideId));
      expect(
          socket.sentEvents.where((e) => e.event == 'ride:request').length, 2);
    });
  });

  group('nearby-Keke markers during searching', () {
    /// The feed is fetched asynchronously; give it a turn to land.
    Future<void> settleFeed() async {
      for (var i = 0; i < 6; i++) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    test('markers are requested for the searching ride and rendered', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1'), _marker('k2')];
      nearbyApi.eligibleCount = 4;

      controller.requestRide();
      final rideId = controller.state.rideId!;
      await settleFeed();

      expect(nearbyApi.requestedRideIds, contains(rideId));
      expect(controller.state.nearbyKekes.kekes.map((k) => k.key), ['k1', 'k2']);
      // Honest count survives the display cap.
      expect(controller.state.nearbyKekes.eligibleCount, 4);
    });

    test('an empty eligible pool produces no markers at all', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [];

      controller.requestRide();
      await settleFeed();

      expect(controller.state.nearbyKekes.kekes, isEmpty);
      expect(controller.state.nearbyKekes.eligibleCount, 0);
      expect(controller.state.nearbyKekes.shortLabel, 'Checking for Kekes nearby…');
    });

    test('a driver accepting clears every unrelated nearby marker', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1'), _marker('k2')];
      controller.requestRide();
      await settleFeed();
      expect(controller.state.nearbyKekes.kekes, isNotEmpty);

      socket.injectEvent({
        'event': 'ride:assigned',
        'driverDetails': {'firstName': 'Chidi'},
        'pickupCode': 'AB12',
      });
      await settleFeed();

      expect(controller.state.step, BookingStep.confirmed);
      expect(controller.state.nearbyKekes.kekes, isEmpty,
          reason: 'only the assigned driver may remain on the map');
      expect(controller.state.nearbyKekes.eligibleCount, 0);
    });

    test('no further marker requests are made after acceptance', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1')];
      controller.requestRide();
      await settleFeed();

      socket.injectEvent({
        'event': 'ride:assigned',
        'driverDetails': {'firstName': 'Chidi'},
      });
      await settleFeed();
      final callsAtAcceptance = nearbyApi.requestedRideIds.length;

      await Future<void>.delayed(
          BookingController.searchingKekeRefresh + const Duration(milliseconds: 60));
      expect(nearbyApi.requestedRideIds.length, callsAtAcceptance);
    });

    test('passenger cancellation removes the markers', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1')];
      controller.requestRide();
      await settleFeed();
      expect(controller.state.nearbyKekes.kekes, isNotEmpty);

      socket.injectEvent({'event': 'ride:cancelled'});
      await settleFeed();

      expect(controller.state.nearbyKekes.kekes, isEmpty);
    });

    test('a no-driver outcome removes the markers', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1')];
      controller.requestRide();
      await settleFeed();

      socket.injectEvent({'event': 'ride:failed', 'code': 'NO_DRIVER_ACCEPTED'});
      await settleFeed();

      expect(controller.state.step, BookingStep.previewEstimate);
      expect(controller.state.nearbyKekes.kekes, isEmpty,
          reason: 'the search is over — the map must not still promise supply');
    });

    test('round two refreshes the marker set for the wider search area', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('near')];
      controller.requestRide();
      await settleFeed();
      final callsBefore = nearbyApi.requestedRideIds.length;

      // Round two reaches further out and finds an additional Keke.
      nearbyApi.markers = [_marker('near'), _marker('far')];
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      await settleFeed();

      expect(nearbyApi.requestedRideIds.length, greaterThan(callsBefore),
          reason: 'the wider area must be fetched immediately, not one interval later');
      expect(controller.state.nearbyKekes.kekes.map((k) => k.key), ['near', 'far']);
      // The round-one driver who is still eligible was NOT torn down.
      expect(controller.state.nearbyKekes.kekes.first.key, 'near');
    });

    test('a driver no longer eligible in round two disappears', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('went_busy'), _marker('still_free')];
      controller.requestRide();
      await settleFeed();

      nearbyApi.markers = [_marker('still_free')];
      socket.injectEvent({
        'event': 'ride:dispatch_round',
        'rideId': controller.state.rideId,
        'dispatchRound': 2,
      });
      await settleFeed();

      expect(controller.state.nearbyKekes.kekes.map((k) => k.key), ['still_free']);
    });

    test('a realtime/network failure ages markers out instead of freezing them',
        () async {
      await arrangeAtFareScreen();
      // Markers that expire almost immediately, as they would after a long
      // disconnection.
      nearbyApi.markers = [
        {
          'key': 'about_to_expire',
          'lat': 6.21,
          'lng': 7.05,
          'expiresAt': DateTime.now()
              .subtract(const Duration(seconds: 1))
              .millisecondsSinceEpoch,
        },
      ];
      controller.requestRide();
      await settleFeed();

      // Connection drops; the next refresh fails.
      nearbyApi.shouldFail = true;
      socket.injectEvent({'event': 'socket:reconnected'});
      await settleFeed();

      expect(controller.state.nearbyKekes.kekes, isEmpty,
          reason: 'unverifiable supply must not stay on the map');
    });

    test('a failed refresh keeps still-valid markers rather than blanking', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('valid')];
      controller.requestRide();
      await settleFeed();
      expect(controller.state.nearbyKekes.kekes, hasLength(1));

      nearbyApi.shouldFail = true;
      socket.injectEvent({'event': 'socket:reconnected'});
      await settleFeed();

      // Within its expiry window, so it stays — no flicker on a transient blip.
      expect(controller.state.nearbyKekes.kekes.map((k) => k.key), ['valid']);
    });

    test('a late response for a previous ride cannot repopulate a new one',
        () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('old')];
      controller.requestRide();
      final firstRideId = controller.state.rideId;
      await settleFeed();

      socket.injectEvent({'event': 'ride:failed', 'code': 'NO_DRIVER_ACCEPTED'});
      await settleFeed();
      expect(controller.state.nearbyKekes.kekes, isEmpty);

      controller.searchAgain();
      expect(controller.state.rideId, isNot(firstRideId));
      // Markers start empty for the new ride, not inherited from the old one.
      expect(controller.state.nearbyKekes.kekes, isEmpty);
    });

    test('markers are never fetched outside a search', () async {
      await arrangeAtFareScreen();
      nearbyApi.markers = [_marker('k1')];

      // Sitting on the fare screen, no request made yet.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(nearbyApi.requestedRideIds, isEmpty);
      expect(controller.state.nearbyKekes.kekes, isEmpty);
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
