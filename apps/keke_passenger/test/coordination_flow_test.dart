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
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';
import 'package:keke_passenger/features/passenger/domain/ride_coordination.dart';

/// Passenger-side coordination behaviour.
///
/// The property under test throughout: the SERVER decides, the app renders and
/// reports. Nothing here may conclude on its own that a ride is late, answered or
/// cancelled — every one of those is a fact that arrives from the backend, and a
/// test that lets the app invent one would be testing the wrong system.

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

  @override
  Future<void> handleInitialMessage() async {}

  /// Pushes a notification payload as if the OS had handed it to us.
  void deliver(Map<String, dynamic> data) => injectIntent(data);
}

class _SilentSoundService extends SoundService {
  @override
  Future<void> playAlert() async {}
}

/// Serves the coordination recovery endpoint, so app-restart and reconnect
/// behaviour can be exercised against a real server answer.
class _FakeCoordinationApi {
  /// What `/rides/:id/coordination` returns. Null means "nothing to coordinate".
  Map<String, dynamic>? coordination;

  /// What `/rides/active/passenger` returns for the ride.
  Map<String, dynamic>? activeRide;

  int coordinationCalls = 0;
  bool shouldFail = false;
}

void main() {
  late SocketService socket;
  late BookingController controller;
  late List<(String, Map<String, Object?>)> events;
  late _FakeCoordinationApi api;
  late _FakeNotificationService notifications;

  ApiClient stubApiClient(_FakeCoordinationApi api) {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        if (api.shouldFail) {
          return handler.reject(
              DioException(requestOptions: options, message: 'offline'), true);
        }
        if (options.path == '/rides/active/passenger') {
          return handler.resolve(Response(
            requestOptions: options,
            statusCode: 200,
            data: api.activeRide ?? const <String, dynamic>{},
          ));
        }
        if (RegExp(r'^/rides/.+/coordination$').hasMatch(options.path)) {
          api.coordinationCalls++;
          return handler.resolve(Response(
            requestOptions: options,
            statusCode: 200,
            data: {'coordination': api.coordination},
          ));
        }
        return handler.reject(
            DioException(requestOptions: options, message: 'offline'), true);
      },
    ));
    return ApiClient(dio);
  }

  /// A passenger with an accepted ride and a driver on the way — where every
  /// delayed-ride conversation begins.
  Future<void> arrangeOnAcceptedRide() async {
    socket = SocketService.offline();
    events = [];
    api = _FakeCoordinationApi();
    notifications = _FakeNotificationService();
    controller = BookingController(
      _FakeMapRepository(),
      socket,
      stubApiClient(api),
      notifications,
      _SilentSoundService(),
      AnalyticsService(sink: (e, p) => events.add((e, p))),
      'passenger-1',
      'Ada',
      'Obi',
    );
    await Future<void>.delayed(Duration.zero);
    controller.setDestination('Shoprite Onitsha', _destination);
    await Future<void>.delayed(Duration.zero);
    controller.requestRide();
    socket.injectEvent({
      'event': 'ride:assigned',
      'rideId': controller.state.rideId,
      'driverDetails': {'name': 'Chidi Okeke', 'phone': '08031234567'},
      'pickupCode': '4821',
    });
    await Future<void>.delayed(Duration.zero);
    // Requests emitted while arranging are not the subject of any test.
    socket.sentEvents.clear();
    events.clear();
  }

  String rideIdOf() => controller.state.rideId!;

  /// Deliver a socket event and let the broadcast stream drain.
  ///
  /// `injectEvent` is asynchronous — the controller's listener runs on a
  /// microtask — so asserting immediately after would read the state as it was
  /// BEFORE the event, which is a test that always passes for the wrong reason.
  Future<void> inject(Map<String, dynamic> event) async {
    socket.injectEvent(event);
    await Future<void>.delayed(Duration.zero);
  }

  /// The decision prompt the sweeper emits when a driver is past their ETA.
  Map<String, dynamic> decisionPrompt({
    String waitingFor = 'driver',
    int extensionsRemaining = 1,
    String rideStatus = 'accepted',
    String? eventId,
    Duration respondIn = const Duration(minutes: 3),
  }) =>
      {
        'event': 'ride:stale_decision_required',
        'rideId': rideIdOf(),
        'eventId': eventId ?? '${rideIdOf()}:decision:1',
        'rideStatus': rideStatus,
        'reason': 'driver_never_arrived',
        'waitingFor': waitingFor,
        'round': 1,
        'extensionsRemaining': extensionsRemaining,
        'respondBySeconds': respondIn.inSeconds,
        'respondByAt':
            DateTime.now().toUtc().add(respondIn).toIso8601String(),
        // Both, exactly as the sweeper sends them: `options` is what the server
        // ACCEPTS, `actions` is what this role should be OFFERED.
        'options': ['wait', 'cancel'],
        'actions': waitingFor == 'driver'
            ? ['keep_waiting', 'call_other_party', 'request_cancel']
            : ['on_my_way', 'call_other_party', 'request_cancel'],
        'role': 'passenger',
        'title': waitingFor == 'driver'
            ? 'Your driver is taking longer than expected'
            : 'Your driver is waiting',
        'body': waitingFor == 'driver'
            ? 'Waiting for your driver to confirm.'
            : 'Please meet your driver at the pickup point.',
      };

  ({String event, dynamic data})? sent(String name) {
    for (final e in socket.sentEvents.reversed) {
      if (e.event == name) return e;
    }
    return null;
  }

  // Guarded: a pure-parser test builds no controller, and disposing the previous
  // test's controller twice throws rather than failing the test it belongs to.
  BookingController? disposed;
  tearDown(() {
    if (!identical(disposed, controller)) {
      controller.dispose();
      disposed = controller;
    }
  });

  // ─── 2. Passenger delayed status renders ───────────────────────────────

  test('2. a delayed-driver prompt becomes a coordination state the passenger '
      'can see and answer', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.awaitingDecision);
    expect(c.title, 'Your driver is taking longer than expected');
    expect(c.body, 'Waiting for your driver to confirm.');
    expect(c.needsAnswer, isTrue);
    // Continue waiting AND cancel, per the spec's state A.
    expect(c.actions, contains(CoordinationAction.keepWaiting));
    expect(c.actions, contains(CoordinationAction.requestCancel));
    // The ride is untouched: a delay is not a cancellation.
    expect(controller.state.step, BookingStep.confirmed);
    expect(events.map((e) => e.$1), contains('coordination_prompt_displayed'));
  });

  test('the countdown comes from the server timestamp, not a local timer',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt(respondIn: const Duration(seconds: 90)));

    final c = controller.state.coordination!;
    final now = DateTime.now().toUtc();
    // Anchored to respondByAt: a phone asleep for a minute loses a minute, which
    // is the whole point of sending an absolute deadline.
    expect(c.secondsRemaining(now), closeTo(90, 2));
    expect(c.secondsRemaining(now.add(const Duration(seconds: 60))),
        closeTo(30, 2));
    // Never negative, however long the app was away.
    expect(c.secondsRemaining(now.add(const Duration(hours: 4))), 0);
  });

  // ─── 4. Passenger selects continue waiting ─────────────────────────────

  test('4. Continue waiting sends the decision and shows a pending state',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.keepWaiting);

    final emitted = sent('ride:stale_decision')!;
    final payload = emitted.data as Map<String, dynamic>;
    expect(payload['rideId'], rideIdOf());
    expect(payload['role'], 'passenger');
    expect(payload['choice'], 'wait');
    // In flight, so the buttons are gone and a second tap cannot double-submit.
    expect(controller.state.coordination!.submitting, isTrue);
    expect(controller.state.coordination!.needsAnswer, isFalse);
    expect(events.map((e) => e.$1), contains('coordination_continue_waiting'));
  });

  test('a second tap while a response is in flight is ignored', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.keepWaiting);
    controller.respondToCoordination(CoordinationAction.keepWaiting);
    controller.respondToCoordination(CoordinationAction.keepWaiting);

    expect(
      socket.sentEvents.where((e) => e.event == 'ride:stale_decision').length,
      1,
    );
  });

  test('Continue waiting is not offered once the server says no extensions '
      'remain', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt(extensionsRemaining: 0));

    // Offering a button the backend would refuse is worse than not offering it.
    expect(controller.state.coordination!.canKeepWaiting, isFalse);
  });

  // ─── 5. Passenger requests cancellation ────────────────────────────────

  test('5. requesting cancellation keeps the ride active until the backend '
      'confirms', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.requestCancel);

    expect(sent('ride:cancel_request'), isNotNull);
    // Crucially: no local cancellation. The ride is still confirmed.
    expect(controller.state.step, BookingStep.confirmed);
    expect(controller.state.rideId, isNotNull);

    // The server accepts the request for delivery and names the deadline.
    final deadline = DateTime.now().toUtc().add(const Duration(minutes: 3));
    await inject({
      'event': 'ride:cancel_request_ack',
      'rideId': rideIdOf(),
      'accepted': true,
      'awaiting': 'driver',
      'respondByAt': deadline.toIso8601String(),
      'eventId': '${rideIdOf()}:cancel_request_passenger:1',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.cancellationRequested);
    expect(c.requestedByMe, isTrue);
    // The requester waits; they do not get answer buttons for their own request.
    expect(c.needsAnswer, isFalse);
    expect(c.respondByAt, isNotNull);
    expect(controller.state.step, BookingStep.confirmed);
  });

  test('a duplicate cancellation request is reported honestly, not swallowed',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.requestCancel);

    await inject({
      'event': 'ride:cancel_request_ack',
      'rideId': rideIdOf(),
      'accepted': false,
      'reason': 'request_already_pending',
    });

    expect(controller.state.errorMessage,
        contains('already a cancellation request'));
    expect(controller.state.coordination!.submitting, isFalse);
    expect(controller.state.step, BookingStep.confirmed);
  });

  // ─── 8/9. Driver requests cancellation; passenger accepts ──────────────

  test('8. a driver-initiated cancellation request is shown as a question, not '
      'an outcome', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancel_requested',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:cancel_request_driver:1',
      'rideStatus': 'accepted',
      'requestedBy': 'driver',
      'respondByAt':
          DateTime.now().toUtc().add(const Duration(minutes: 3)).toIso8601String(),
      'actions': ['accept_cancellation', 'continue_ride'],
      'title': 'Your driver would like to cancel this ride',
      'body': 'You can accept, or ask them to keep coming.',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.cancellationRequested);
    expect(c.cancellationRequestedBy, 'driver');
    expect(c.requestedByMe, isFalse);
    expect(c.needsAnswer, isTrue);
    expect(c.actions, contains(CoordinationAction.acceptCancellation));
    expect(c.actions, contains(CoordinationAction.continueRide));
    // Still an active ride.
    expect(controller.state.step, BookingStep.confirmed);
  });

  test('9. accepting the driver\'s cancellation sends accept and waits for the '
      'server', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancel_requested',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:cancel_request_driver:1',
      'rideStatus': 'accepted',
      'requestedBy': 'driver',
      'actions': ['accept_cancellation', 'continue_ride'],
      'title': 'Your driver would like to cancel this ride',
    });

    controller.respondToCoordination(CoordinationAction.acceptCancellation);

    final payload = sent('ride:cancel_response')!.data as Map<String, dynamic>;
    expect(payload['decision'], 'accept');
    expect(payload['role'], 'passenger');
    // The app does NOT end the ride itself. Only ride:cancelled does that.
    expect(controller.state.step, BookingStep.confirmed);
    expect(events.map((e) => e.$1),
        contains('coordination_cancellation_accepted'));
  });

  test('declining the driver\'s request sends continue and keeps the ride',
      () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancel_requested',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:cancel_request_driver:1',
      'rideStatus': 'accepted',
      'requestedBy': 'driver',
      'actions': ['accept_cancellation', 'continue_ride'],
      'title': 'Your driver would like to cancel this ride',
    });

    controller.respondToCoordination(CoordinationAction.continueRide);

    final payload = sent('ride:cancel_response')!.data as Map<String, dynamic>;
    expect(payload['decision'], 'continue');
    expect(controller.state.step, BookingStep.confirmed);
    expect(events.map((e) => e.$1),
        contains('coordination_cancellation_declined'));
  });

  // ─── 10. Decision expires before response ──────────────────────────────

  test('10. an expired window says so plainly and does not claim an outcome',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt(respondIn: const Duration(seconds: 30)));

    final c = controller.state.coordination!;
    final afterDeadline = DateTime.now().toUtc().add(const Duration(minutes: 5));

    expect(c.hasExpired(afterDeadline), isTrue);
    expect(c.secondsRemaining(afterDeadline), 0);
    // Expiry is NOT a cancellation. Only the backend ends a ride, and it has not.
    expect(controller.state.step, BookingStep.confirmed);
    expect(controller.state.closure, isNull);
    // And the copy says something honest rather than "error".
    expect(c.accessibilityLabel(afterDeadline),
        contains('Time to respond has passed'));
  });

  // ─── 11/12. Reconnect restores the right thing ─────────────────────────

  test('11. reconnect restores an unresolved prompt from the server', () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:decision:1',
      'rideStatus': 'accepted',
      'stage': 'awaiting_decision',
      'title': 'Your driver is taking longer than expected',
      'body': 'Waiting for your driver to confirm.',
      'actions': ['keep_waiting', 'call_other_party', 'request_cancel'],
      'decisionOpen': true,
      'extensionsRemaining': 1,
      'respondByAt':
          DateTime.now().toUtc().add(const Duration(minutes: 2)).toIso8601String(),
    };

    await inject({'event': 'socket:reconnected'});
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.awaitingDecision);
    expect(c.decisionOpen, isTrue);
    expect(c.needsAnswer, isTrue);
    // Restored from the server's timestamp, not restarted.
    expect(c.secondsRemaining(DateTime.now().toUtc()), closeTo(120, 3));
  });

  test('12. reconnect does NOT restore a prompt the server has resolved',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    expect(controller.state.coordination!.needsAnswer, isTrue);

    // The server now reports nothing to coordinate — the question is settled.
    api.coordination = null;
    await inject({'event': 'socket:reconnected'});
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(controller.state.coordination, isNull);
  });

  test('a decision already answered by this passenger comes back as answered, '
      'not as a fresh question', () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:decision:1',
      'rideStatus': 'accepted',
      'stage': 'confirmed_en_route',
      'title': 'Your driver confirmed they are still coming',
      'body': 'They are on their way to the pickup point.',
      'actions': ['keep_waiting', 'call_other_party'],
      'decisionOpen': false,
      'decidedBy': 'passenger',
      'decidedChoice': 'wait',
      'extensionsRemaining': 0,
    };

    await controller.refreshCoordination();

    final c = controller.state.coordination!;
    expect(c.decidedByMe, isTrue);
    expect(c.answered, isTrue);
    expect(c.needsAnswer, isFalse);
  });

  // ─── 13. Duplicate socket and push events are deduplicated ─────────────

  test('13. the same prompt arriving twice over the socket raises one prompt',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    await inject(decisionPrompt());
    await inject(decisionPrompt());

    final displayed = events
        .where((e) => e.$1 == 'coordination_prompt_displayed')
        .length;
    expect(displayed, 1);
  });

  test('13b. a push carrying the same eventId does not add a second prompt',
      () async {
    await arrangeOnAcceptedRide();
    // Push lands first (app was backgrounded), socket event follows on resume.
    notifications.deliver({
      'type': 'STALE_RIDE_DECISION',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:decision:1',
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    await inject(decisionPrompt(eventId: '${rideIdOf()}:decision:1'));

    // One notification event, and NO second prompt_displayed for the same id.
    expect(
        events.where((e) => e.$1 == 'coordination_notification_displayed').length,
        1);
    expect(
        events.where((e) => e.$1 == 'coordination_prompt_displayed').length, 0);
  });

  test('a genuinely new round does raise a new prompt', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt(eventId: '${rideIdOf()}:decision:1'));
    await inject(decisionPrompt(eventId: '${rideIdOf()}:decision:2'));

    expect(
        events.where((e) => e.$1 == 'coordination_prompt_displayed').length, 2);
  });

  // ─── 14/16/17. Lifecycle transitions clear the conversation ────────────

  test('14/16. arrival clears the delayed-driver prompt — being here IS the '
      'answer', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    expect(controller.state.coordination, isNotNull);

    await inject({
      'event': 'ride:status_update',
      'rideId': rideIdOf(),
      'status': 'arrived',
    });

    expect(controller.state.step, BookingStep.arrived);
    expect(controller.state.coordination, isNull);
  });

  test('16. the trip starting clears every delayed-pickup state', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    await inject({
      'event': 'ride:status_update',
      'rideId': rideIdOf(),
      'status': 'started',
    });

    expect(controller.state.step, BookingStep.started);
    expect(controller.state.coordination, isNull);
  });

  test('17. an in-progress ride never shows coordination UI, even if the '
      'server sends one', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:status_update',
      'rideId': rideIdOf(),
      'status': 'started',
    });

    // A late-arriving event for a trip already under way must be ignored: the
    // backend only ever FLAGS an in-progress ride, it never cancels one, so a
    // prompt here would describe something that cannot happen.
    await inject(decisionPrompt(rideStatus: 'in_progress'));
    await inject(decisionPrompt());

    expect(controller.state.coordination, isNull);
  });

  test('a payload whose rideStatus is in_progress is rejected by the parser',
      () async {
    await arrangeOnAcceptedRide();
    final parsed = RideCoordination.fromWire({
      'rideId': 'RIDE-1',
      'event': 'ride:stale_decision_required',
      'rideStatus': 'in_progress',
      'title': 'Something',
      'body': 'Something else',
    });
    expect(parsed, isNull);
  });

  // ─── 15. Passenger acknowledges they are coming ────────────────────────

  test('15. "I\'m coming" is reported to the backend so the driver sees it',
      () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:delay_notice',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:warning:arrived',
      'rideStatus': 'arrived',
      'role': 'passenger',
      'delayState': 'waiting_for_passenger',
      'title': 'Your driver is waiting',
      'body': 'Please meet your driver at the pickup point.',
      'actions': ['on_my_way', 'call_other_party', 'request_cancel'],
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.waitingForPassenger);
    expect(c.actions, contains(CoordinationAction.onMyWay));

    controller.respondToCoordination(CoordinationAction.onMyWay);

    final payload = sent('ride:activity')!.data as Map<String, dynamic>;
    expect(payload['type'], 'passenger_keep_waiting');
    expect(payload['role'], 'passenger');
    // The passenger is never labelled a no-show, and the ride carries on.
    expect(controller.state.step, BookingStep.confirmed);
    expect(controller.state.coordination!.answered, isTrue);
  });

  // ─── 18. Both-unresponsive cancellation displays correctly ─────────────

  test('18. a ride closed because neither party answered says exactly that, '
      'without blame', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideIdOf(),
      'reason': 'SYSTEM_ABANDONED_BY_BOTH',
      'systemCancelled': true,
      'outcome': 'closed_no_response',
      'title': 'Ride closed',
      'body': "This ride was closed because we couldn't reach either you or "
          'the driver.',
    });

    expect(controller.state.closure, RideClosure.closedNoResponse);
    expect(controller.state.closure!.isNoFault, isTrue);
    expect(controller.state.closureBody, contains("couldn't reach either you"));
    expect(controller.state.closure!.primaryAction, 'Find another Keke');
    // Not dressed up as the passenger's own cancellation.
    expect(controller.state.notice, isNull);
    expect(controller.state.coordination, isNull);
  });

  test('a driver-initiated cancellation is NOT reported as the passenger\'s '
      'own', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideIdOf(),
      'reason': 'CANCELLED_MUTUAL_DRIVER_INITIATED',
      'outcome': 'cancelled_by_driver',
      'title': 'Ride cancelled',
      'body': 'Your driver could not complete this pickup. '
          'You can book another Keke now.',
    });

    // This is the defect the audit found: every cancellation used to be read as
    // passengerCancelled, so a passenger was told they cancelled a ride the
    // driver had.
    expect(controller.state.closure, RideClosure.cancelledByDriver);
    expect(controller.state.closureBody, contains('could not complete'));
    expect(controller.state.notice?.title, isNot(contains('You cancelled')));
  });

  test('the passenger\'s own cancellation still reads as their own', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideIdOf(),
      'reason': 'passenger_cancelled',
      'outcome': 'cancelled_by_passenger',
    });

    // Falls through to the ordinary notice path — no explaining card needed.
    expect(controller.state.closure, isNull);
    expect(controller.state.notice, isNotNull);
  });

  test('a cancellation for a DIFFERENT ride does not tear this one down',
      () async {
    await arrangeOnAcceptedRide();
    final mine = rideIdOf();

    await inject({
      'event': 'ride:cancelled',
      'rideId': 'RIDE-somebody-else',
      'outcome': 'offer_withdrawn',
    });

    expect(controller.state.rideId, mine);
    expect(controller.state.step, BookingStep.confirmed);
  });

  // ─── 19. Support escalation state ──────────────────────────────────────

  test('19. escalation offers a way forward and never reads as an error',
      () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:delay_escalated',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:escalation:driver_unreachable',
      'rideStatus': 'accepted',
      'delayState': 'driver_offline',
      'unreachableParty': 'driver',
      'title': 'We are unable to reach your driver',
      'body': 'We have not been able to contact them. You can look for another '
          'Keke, or keep waiting.',
      'actions': ['find_another_driver', 'continue_waiting', 'request_cancel'],
      'supportNotified': true,
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.escalated);
    expect(c.escalatedToSupport, isTrue);
    expect(c.actions, contains(CoordinationAction.findAnotherDriver));
    expect(c.actions, contains(CoordinationAction.keepWaiting));
    // No engineering code anywhere in what the passenger reads.
    expect(c.title, isNot(contains('driver_unreachable')));
    expect(c.body, isNot(contains('_')));
    // The ride is alive: escalation is explicitly not cancellation.
    expect(controller.state.step, BookingStep.confirmed);
  });

  test('Find another Keke asks the backend rather than cancelling locally',
      () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:delay_escalated',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:escalation:driver_unreachable',
      'rideStatus': 'accepted',
      'title': 'We are unable to reach your driver',
      'actions': ['find_another_driver', 'request_cancel'],
    });

    controller.respondToCoordination(CoordinationAction.findAnotherDriver);

    expect(sent('ride:cancel_request'), isNotNull);
    expect(controller.state.step, BookingStep.confirmed);
    expect(
        events.map((e) => e.$1), contains('coordination_find_another_keke'));
  });

  // ─── 20. Network loss during response ──────────────────────────────────

  test('20. losing the network mid-response leaves the ride intact and the '
      'prompt answerable', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    api.shouldFail = true;
    controller.respondToCoordination(CoordinationAction.keepWaiting);
    // No ack will ever arrive. The ride must not be assumed cancelled, and the
    // coordination state must not be lost.
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(controller.state.step, BookingStep.confirmed);
    expect(controller.state.coordination, isNotNull);
    expect(controller.state.closure, isNull);

    // A refresh that fails leaves what we had rather than wiping it.
    await controller.refreshCoordination();
    expect(controller.state.coordination, isNotNull);
  });

  // ─── 21. Backend rejects a stale response ──────────────────────────────

  test('21. a response the backend refuses is reported honestly and the truth '
      'is re-read', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.keepWaiting);

    api.coordination = null;
    await inject({
      'event': 'ride:stale_decision_ack',
      'rideId': rideIdOf(),
      'accepted': false,
      'reason': 'already_decided',
      'decidedBy': 'driver',
      'decidedChoice': 'wait',
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // Told plainly what happened — the other person got there first.
    expect(controller.state.errorMessage, contains('already answered'));
    expect(events.map((e) => e.$1), contains('coordination_response_rejected'));
    // And the app went back to the server rather than trusting its own picture.
    expect(api.coordinationCalls, greaterThan(0));
    expect(controller.state.coordination, isNull);
  });

  test('an extension limit refusal explains itself instead of failing silently',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.keepWaiting);

    await inject({
      'event': 'ride:stale_decision_ack',
      'rideId': rideIdOf(),
      'accepted': false,
      'reason': 'extension_limit_reached',
      'message': 'You have already chosen to wait once. '
          'Please arrive, start the trip, or cancel.',
    });

    expect(controller.state.errorMessage, contains('already chosen to wait'));
    expect(controller.state.coordination!.submitting, isFalse);
  });

  test('an accepted response settles the card as answered', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.keepWaiting);

    await inject({
      'event': 'ride:stale_decision_ack',
      'rideId': rideIdOf(),
      'accepted': true,
      'choice': 'wait',
    });

    final c = controller.state.coordination!;
    expect(c.answered, isTrue);
    expect(c.submitting, isFalse);
    expect(c.needsAnswer, isFalse);
    expect(events.map((e) => e.$1), contains('coordination_prompt_acknowledged'));
  });

  // ─── 22. Notification tap opens the correct ride ───────────────────────

  test('22. a coordination push re-reads the state for THIS ride', () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:decision:1',
      'rideStatus': 'accepted',
      'stage': 'awaiting_decision',
      'title': 'Your driver is taking longer than expected',
      'body': 'Waiting for your driver to confirm.',
      'actions': ['keep_waiting', 'request_cancel'],
      'decisionOpen': true,
      'extensionsRemaining': 1,
    };

    // As if the passenger tapped a lock-screen notification.
    notifications.deliver({
      'type': 'STALE_RIDE_DECISION',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:decision:1',
      'intent': 'active',
    });
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(api.coordinationCalls, greaterThan(0));
    expect(controller.state.coordination!.stage,
        CoordinationStage.awaitingDecision);
    expect(controller.state.coordination!.rideId, rideIdOf());
  });

  test('a non-coordination push does not trigger a coordination read', () async {
    await arrangeOnAcceptedRide();
    notifications.deliver({'type': 'WALLET_TOPUP', 'rideId': rideIdOf()});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(api.coordinationCalls, 0);
  });

  // ─── 23. Accessibility semantics ───────────────────────────────────────

  test('23. the accessibility label carries the situation AND the remaining '
      'time in words', () async {
    await arrangeOnAcceptedRide();
    // 150s, not 120: the label rounds DOWN, so a deadline exactly on the minute
    // boundary reads as "1 minute" the instant any time has elapsed.
    await inject(decisionPrompt(respondIn: const Duration(seconds: 150)));

    final c = controller.state.coordination!;
    final label = c.accessibilityLabel(DateTime.now().toUtc());

    expect(label, contains('Your driver is taking longer than expected'));
    expect(label, contains('Waiting for your driver to confirm.'));
    // Countdown in words, so it is not conveyed by colour or a shrinking digit
    // alone.
    expect(label, contains('minutes left to respond'));

    final nearly = c.accessibilityLabel(
        DateTime.now().toUtc().add(const Duration(seconds: 90)));
    expect(nearly, contains('seconds left to respond'));
  });

  test('the label states a submitted or answered response for a screen reader',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    final now = DateTime.now().toUtc();

    final submitting =
        controller.state.coordination!.copyWith(submitting: true);
    expect(submitting.accessibilityLabel(now), contains('Sending your response'));

    final answered = controller.state.coordination!
        .copyWith(answered: true, decisionOpen: false);
    expect(answered.accessibilityLabel(now), contains('has been sent'));
  });

  // ─── 24. No silent cancellation path remains ───────────────────────────

  test('24. no passenger action cancels a ride without the backend saying so',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    final mine = rideIdOf();

    // Every action the card can produce, fired at the controller in turn.
    for (final action in CoordinationAction.values) {
      controller.respondToCoordination(action);
      // Clear `submitting` so the next action is not swallowed by the
      // double-tap guard — the point here is that none of them END the ride.
      final c = controller.state.coordination;
      if (c != null) {
        await inject({
          'event': 'ride:stale_decision_ack',
          'rideId': mine,
          'accepted': true,
          'choice': 'wait',
        });
      }
    }

    // Not one of them terminated the ride locally.
    expect(controller.state.rideId, mine);
    expect(controller.state.step, BookingStep.confirmed);
    expect(controller.state.closure, isNull);
  });

  test('the app never invents a coordination state from silence', () async {
    await arrangeOnAcceptedRide();
    // No coordination events at all, and plenty of time.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(controller.state.coordination, isNull);
    expect(controller.state.closure, isNull);
    expect(controller.state.step, BookingStep.confirmed);
  });

  test('coordination events for another ride are ignored', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:stale_decision_required',
      'rideId': 'RIDE-not-mine',
      'eventId': 'RIDE-not-mine:decision:1',
      'rideStatus': 'accepted',
      'title': 'Your driver is taking longer than expected',
      'options': ['wait', 'cancel'],
    });
    expect(controller.state.coordination, isNull);
  });

  // ─── Driver-confirmed and reminder states (spec §3 B) ──────────────────

  test('a driver confirming en route becomes a calm status, not a question',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    await inject({
      'event': 'ride:stale_decision_resolved',
      'rideId': rideIdOf(),
      'decidedBy': 'driver',
      'choice': 'wait',
      'message': 'Your driver is still on the way.',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.confirmedEnRoute);
    expect(c.needsAnswer, isFalse);
    expect(c.respondByAt, isNull);
    // Continue-waiting/call/cancel remain available per spec state B.
    expect(c.actions, contains(CoordinationAction.callOtherParty));
    expect(c.actions, contains(CoordinationAction.requestCancel));
  });

  test('a slow-cadence reminder updates the card without re-asking', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:delay_update',
      'rideId': rideIdOf(),
      'eventId': '${rideIdOf()}:reminder:1700000000000',
      'rideStatus': 'accepted',
      'delayState': 'delayed_driver_confirmed_en_route',
      'role': 'passenger',
      'title': 'Your driver is still on the way',
      'body': 'They have confirmed they are coming. You can call or message '
          'them, or cancel if you need to.',
      'actions': ['continue_waiting', 'call_driver', 'request_cancel'],
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.confirmedEnRoute);
    expect(c.decisionOpen, isFalse);
    expect(c.needsAnswer, isFalse);
    expect(c.actions, contains(CoordinationAction.keepWaiting));
    expect(c.actions, contains(CoordinationAction.callOtherParty));
  });

  test('a call is reported as activity so the server counts it as engagement',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.callOtherParty);

    final payload = sent('ride:activity')!.data as Map<String, dynamic>;
    expect(payload['type'], 'passenger_called_driver');
    expect(events.map((e) => e.$1), contains('coordination_call_used'));
    // Reporting a call must not consume the open question.
    expect(controller.state.coordination!.needsAnswer, isTrue);
  });

  test('analytics never carry message text or coordinates', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.keepWaiting);

    for (final (name, params) in events) {
      if (!name.startsWith('coordination_')) continue;
      expect(params.containsKey('rideId'), isTrue, reason: name);
      expect(params.containsKey('stage'), isTrue, reason: name);
      expect(params.containsKey('role'), isTrue, reason: name);
      expect(params.containsKey('timestamp'), isTrue, reason: name);
      // No location, no message bodies.
      expect(params.keys, isNot(contains('lat')));
      expect(params.keys, isNot(contains('lng')));
      expect(params.keys, isNot(contains('message')));
      expect(params.keys, isNot(contains('body')));
    }
  });
}
