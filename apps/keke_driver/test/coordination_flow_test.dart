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
import 'package:keke_driver/features/driver/domain/ride_coordination.dart';
import 'package:keke_driver/features/driver/domain/trip_request.dart';

/// Driver-side coordination behaviour.
///
/// Same property as the passenger suite: the SERVER decides, the app renders and
/// reports. Being late is not a failing here — the tests check that the app asks
/// rather than accuses, and that no local action ever ends a ride the backend
/// still considers live.

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

  void deliver(Map<String, dynamic> data) => injectIntent(data);
}

class _SilentSoundService extends SoundService {
  @override
  Future<void> playRequestSound() async {}

  @override
  Future<void> stop() async {}
}

/// Serves the coordination recovery endpoint. Everything else fails fast, which
/// keeps the controller off the network without stubbing the whole API.
class _FakeApi {
  Map<String, dynamic>? coordination;
  int coordinationCalls = 0;
  bool shouldFail = false;
}

TripRequest _request(String rideId) => TripRequest(
      id: rideId,
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
  // The controller subscribes to platform channels (foreground task, secure
  // storage) at construction, so the binding must exist before the first one is
  // built.
  TestWidgetsFlutterBinding.ensureInitialized();

  const rideId = 'RIDE-1785000000000';

  late SocketService socket;
  late DriverController controller;
  late List<(String, Map<String, Object?>)> events;
  late _FakeApi api;
  late _FakeNotificationService notifications;

  ApiClient stubApiClient(_FakeApi api) {
    final dio = Dio(BaseOptions(baseUrl: 'http://test.local/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        if (!api.shouldFail &&
            RegExp(r'^/rides/.+/coordination$').hasMatch(options.path)) {
          api.coordinationCalls++;
          return handler.resolve(Response(
            requestOptions: options,
            statusCode: 200,
            data: {'coordination': api.coordination},
          ));
        }
        // Profile fetch, heartbeat, active-ride recovery: all offline. The
        // controller must survive that, which is itself worth asserting.
        return handler.reject(
            DioException(requestOptions: options, message: 'offline'), true);
      },
    ));
    return ApiClient(dio);
  }

  /// A driver who has accepted a ride and is on the way — where every
  /// delayed-pickup conversation begins.
  Future<void> arrangeOnAcceptedRide({TripStep step = TripStep.accepted}) async {
    socket = SocketService.offline();
    events = [];
    api = _FakeApi();
    notifications = _FakeNotificationService();
    controller = DriverController(
      socket,
      stubApiClient(api),
      notifications,
      _SilentSoundService(),
      'driver-1',
      SecureStorageService(const FlutterSecureStorage()),
      null,
      analytics: AnalyticsService(sink: (e, p) => events.add((e, p))),
    );
    await Future<void>.delayed(Duration.zero);
    // Put the controller on an accepted ride without going through the offer
    // flow, which needs a live socket and timers.
    controller.debugSetActiveRide(_request(rideId), step);
    await Future<void>.delayed(Duration.zero);
    socket.sentEvents.clear();
    events.clear();
  }

  /// Deliver a socket event and let the broadcast stream drain. `injectEvent` is
  /// asynchronous, so asserting immediately after would read the state as it was
  /// BEFORE the event.
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
        'rideId': rideId,
        'eventId': eventId ?? '$rideId:decision:1',
        'rideStatus': rideStatus,
        'reason': 'driver_never_arrived',
        'waitingFor': waitingFor,
        'round': 1,
        'extensionsRemaining': extensionsRemaining,
        'respondBySeconds': respondIn.inSeconds,
        'respondByAt': DateTime.now().toUtc().add(respondIn).toIso8601String(),
        // Both, exactly as the sweeper sends them: `options` is what the server
        // ACCEPTS, `actions` is what this role should be OFFERED. For a driver who
        // has not arrived, "wait" means "I'm still coming"; for one parked at the
        // pickup point it means "keep waiting", and only the server knows which.
        'options': ['wait', 'cancel'],
        'actions': waitingFor == 'driver'
            ? ['still_coming', 'call_other_party', 'open_navigation', 'request_cancel']
            : ['keep_waiting', 'call_other_party', 'request_cancel'],
        'role': 'driver',
        'title': waitingFor == 'driver'
            ? 'Are you still heading to the passenger?'
            : 'Passenger is taking longer to come out',
        'body': waitingFor == 'driver'
            ? 'The passenger is waiting. Let us know if you are still on your way.'
            : 'We have reminded the passenger that you are waiting.',
      };

  /// The soft reminder — no open prompt, just a nudge.
  Map<String, dynamic> softReminder({String rideStatus = 'accepted'}) => {
        'event': 'ride:delay_notice',
        'rideId': rideId,
        'eventId': '$rideId:warning:$rideStatus',
        'rideStatus': rideStatus,
        'role': 'driver',
        'delayState': rideStatus == 'arrived'
            ? 'waiting_for_passenger'
            : 'waiting_for_driver',
        'title': rideStatus == 'arrived'
            ? 'Passenger is taking longer to come out'
            : 'Are you still heading to the passenger?',
        'body': rideStatus == 'arrived'
            ? 'We have reminded the passenger that you are waiting.'
            : 'The passenger is waiting. Let us know if you are still on your way.',
        'actions': rideStatus == 'arrived'
            ? ['keep_waiting', 'call_other_party', 'request_cancel']
            : ['still_coming', 'call_other_party', 'open_navigation', 'request_cancel'],
      };

  ({String event, dynamic data})? sent(String name) {
    for (final e in socket.sentEvents.reversed) {
      if (e.event == name) return e;
    }
    return null;
  }

  DriverController? disposed;
  tearDown(() {
    if (!identical(disposed, controller)) {
      controller.dispose();
      disposed = controller;
    }
  });

  // ─── 1. Driver delayed prompt renders ──────────────────────────────────

  test('1. the delayed prompt reaches the driver as a question with a safe '
      'primary action', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.awaitingDecision);
    expect(c.title, 'Are you still heading to the passenger?');
    expect(c.body,
        'The passenger is waiting. Let us know if you are still on your way.');
    expect(c.needsAnswer, isTrue);
    // "I'm still coming" is the safe action; cancel is the secondary.
    expect(c.actions, contains(CoordinationAction.stillComing));
    expect(c.actions, contains(CoordinationAction.requestCancel));
    // Navigation and calling stay available.
    expect(c.actions, contains(CoordinationAction.openNavigation));
    expect(c.actions, contains(CoordinationAction.callOtherParty));
    // The ride is untouched.
    expect(controller.state.tripStep, TripStep.accepted);
    expect(events.map((e) => e.$1), contains('coordination_prompt_displayed'));
  });

  test('the soft reminder is visible in-app, not push-only', () async {
    await arrangeOnAcceptedRide();
    await inject(softReminder());

    // This is the gentlest rung on the ladder and it used to reach nobody who had
    // the app open, because the sweeper sent push only.
    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.runningLate);
    expect(c.actions, contains(CoordinationAction.stillComing));
  });

  // ─── 3. Driver selects still coming ────────────────────────────────────

  test('3. "I\'m still coming" answers an open prompt and blocks a second tap',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.stillComing);

    final payload = sent('ride:stale_decision')!.data as Map<String, dynamic>;
    expect(payload['rideId'], rideId);
    expect(payload['role'], 'driver');
    expect(payload['choice'], 'wait');
    expect(controller.state.coordination!.submitting, isTrue);

    // Double-tap guard.
    controller.respondToCoordination(CoordinationAction.stillComing);
    controller.respondToCoordination(CoordinationAction.stillComing);
    expect(
      socket.sentEvents.where((e) => e.event == 'ride:stale_decision').length,
      1,
    );
    expect(
        events.map((e) => e.$1), contains('coordination_still_coming_selected'));
  });

  test('3b. with no open prompt it uses the driver-only still-coming path',
      () async {
    await arrangeOnAcceptedRide();
    await inject(softReminder());

    controller.respondToCoordination(CoordinationAction.stillComing);

    // ride:still_coming is the event that acks with ride:extension_granted.
    final payload = sent('ride:still_coming')!.data as Map<String, dynamic>;
    expect(payload['rideId'], rideId);
    expect(payload['driverId'], 'driver-1');
    expect(sent('ride:stale_decision'), isNull);
  });

  test('3c. once granted, the driver is told the PASSENGER was notified',
      () async {
    await arrangeOnAcceptedRide();
    await inject(softReminder());
    controller.respondToCoordination(CoordinationAction.stillComing);

    await inject({
      'event': 'ride:extension_granted',
      'rideId': rideId,
      'extendedUntil':
          DateTime.now().toUtc().add(const Duration(minutes: 10)).toIso8601String(),
      'minutes': 10,
    });

    final c = controller.state.coordination!;
    // The confirmation the spec asks for, and the reason it matters: the driver
    // needs to know the passenger heard, not that a button worked.
    expect(c.title, 'Passenger notified that you are still coming');
    expect(c.answered, isTrue);
    expect(c.submitting, isFalse);
    expect(c.respondByAt, isNull);
    // Calm persistent status, not an urgent prompt.
    expect(c.stage, CoordinationStage.confirmedEnRoute);
    expect(c.needsAnswer, isFalse);
  });

  test('confirming still coming does NOT mark the driver arrived', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.stillComing);

    // Saying you are on the way is not being there. Conflating them would let a
    // driver skip the arrival geofence entirely.
    expect(controller.state.tripStep, TripStep.accepted);
    expect(sent('ride:arrived'), isNull);
  });

  test('the extension limit is respected rather than retried forever', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt(extensionsRemaining: 0));
    expect(controller.state.coordination!.canKeepWaiting, isFalse);

    controller.respondToCoordination(CoordinationAction.stillComing);
    await inject({
      'event': 'ride:stale_decision_ack',
      'rideId': rideId,
      'accepted': false,
      'reason': 'extension_limit_reached',
      'message': 'You have already confirmed once. Please arrive or cancel.',
    });

    expect(controller.state.errorMessage, contains('already confirmed once'));
    expect(controller.state.coordination!.submitting, isFalse);
  });

  // ─── 6/7. Driver answers the passenger's cancellation request ──────────

  test('6. the passenger\'s cancellation request is shown as a question, and '
      'accepting it waits for the backend', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancel_requested',
      'rideId': rideId,
      'eventId': '$rideId:cancel_request_passenger:1',
      'rideStatus': 'accepted',
      'requestedBy': 'passenger',
      'respondByAt':
          DateTime.now().toUtc().add(const Duration(minutes: 3)).toIso8601String(),
      'actions': ['accept_cancellation', 'continue_ride'],
      'title': 'Passenger would like to cancel this ride',
      'body': 'You can accept the cancellation, or let them know you are still coming.',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.cancellationRequested);
    expect(c.cancellationRequestedBy, 'passenger');
    expect(c.requestedByMe, isFalse);
    expect(c.needsAnswer, isTrue);
    expect(c.respondByAt, isNotNull);

    controller.respondToCoordination(CoordinationAction.acceptCancellation);

    final payload = sent('ride:cancel_response')!.data as Map<String, dynamic>;
    expect(payload['decision'], 'accept');
    expect(payload['role'], 'driver');
    // The app does not end the ride itself.
    expect(controller.state.tripStep, TripStep.accepted);
    expect(events.map((e) => e.$1),
        contains('coordination_cancellation_accepted'));
  });

  test('7. declining sends continue and the ride carries on', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancel_requested',
      'rideId': rideId,
      'eventId': '$rideId:cancel_request_passenger:1',
      'rideStatus': 'accepted',
      'requestedBy': 'passenger',
      'actions': ['accept_cancellation', 'continue_ride'],
      'title': 'Passenger would like to cancel this ride',
    });

    controller.respondToCoordination(CoordinationAction.continueRide);

    final payload = sent('ride:cancel_response')!.data as Map<String, dynamic>;
    expect(payload['decision'], 'continue');
    expect(controller.state.tripStep, TripStep.accepted);
    expect(events.map((e) => e.$1),
        contains('coordination_cancellation_declined'));
  });

  test('the passenger declining OUR request becomes a calm status', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.requestCancel);

    await inject({
      'event': 'ride:cancel_declined',
      'rideId': rideId,
      'declinedBy': 'passenger',
      'title': 'Your passenger is still coming',
      'body': 'They would like to keep the ride.',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.confirmedEnRoute);
    expect(c.title, 'Your passenger is still coming');
    expect(c.needsAnswer, isFalse);
    expect(controller.state.tripStep, TripStep.accepted);
  });

  // ─── 8. Driver requests cancellation ──────────────────────────────────

  test('8. the driver\'s own cancellation request keeps the ride live and shows '
      'a pending state', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.requestCancel);
    expect(sent('ride:cancel_request'), isNotNull);
    // A request is not a cancellation.
    expect(controller.state.tripStep, TripStep.accepted);

    final deadline = DateTime.now().toUtc().add(const Duration(minutes: 3));
    await inject({
      'event': 'ride:cancel_request_ack',
      'rideId': rideId,
      'accepted': true,
      'awaiting': 'passenger',
      'respondByAt': deadline.toIso8601String(),
      'eventId': '$rideId:cancel_request_driver:1',
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.cancellationRequested);
    expect(c.requestedByMe, isTrue);
    // The requester waits; they get no answer buttons for their own request.
    expect(c.needsAnswer, isFalse);
    expect(c.respondByAt, isNotNull);
    expect(controller.state.tripStep, TripStep.accepted);
  });

  // ─── 4/15. Arrived, waiting for the passenger ─────────────────────────

  test('4/15. arrived-and-waiting offers Keep waiting, and never calls the '
      'passenger a no-show', () async {
    await arrangeOnAcceptedRide(step: TripStep.arrived);
    await inject(softReminder(rideStatus: 'arrived'));

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.waitingForPassenger);
    expect(c.title, 'Passenger is taking longer to come out');
    expect(c.body, 'We have reminded the passenger that you are waiting.');
    expect(c.actions, contains(CoordinationAction.keepWaiting));
    expect(c.actions, contains(CoordinationAction.callOtherParty));
    expect(c.actions, contains(CoordinationAction.requestCancel));
    // No blame in anything the driver reads.
    for (final banned in ['no-show', 'No-show', 'failed', 'fault']) {
      expect(c.title, isNot(contains(banned)));
      expect(c.body, isNot(contains(banned)));
    }

    controller.respondToCoordination(CoordinationAction.keepWaiting);
    final payload = sent('ride:stale_decision')!.data as Map<String, dynamic>;
    expect(payload['choice'], 'wait');
    expect(events.map((e) => e.$1), contains('coordination_keep_waiting'));
  });

  test('the passenger\'s acknowledgement is surfaced to the driver', () async {
    await arrangeOnAcceptedRide(step: TripStep.arrived);
    await inject({
      'event': 'ride:activity_seen',
      'rideId': rideId,
      'by': 'passenger',
      'type': 'passenger_keep_waiting',
    });

    // "They are coming out" is the whole point of the passenger tapping it.
    expect(controller.state.errorMessage, contains('on their way out'));
  });

  // ─── 14/16/17. Lifecycle transitions ──────────────────────────────────

  test('14. marking arrived while the prompt is up clears it — being here IS '
      'the answer', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    expect(controller.state.coordination, isNotNull);

    controller.markArrived();

    expect(controller.state.tripStep, TripStep.arrived);
    expect(controller.state.coordination, isNull);
    expect(sent('ride:arrived'), isNotNull);
  });

  test('16. starting the trip clears every delayed-pickup state', () async {
    await arrangeOnAcceptedRide(step: TripStep.arrived);
    await inject(softReminder(rideStatus: 'arrived'));
    expect(controller.state.coordination, isNotNull);

    controller.startTrip();

    expect(controller.state.tripStep, TripStep.started);
    expect(controller.state.coordination, isNull);
  });

  test('17. a trip under way never shows coordination UI, even if the server '
      'sends one', () async {
    await arrangeOnAcceptedRide(step: TripStep.started);

    await inject(decisionPrompt(rideStatus: 'in_progress'));
    await inject(decisionPrompt());
    await inject(softReminder());

    // The backend only ever FLAGS an in-progress ride for a human. A prompt here
    // would describe something that cannot happen.
    expect(controller.state.coordination, isNull);
  });

  // ─── 11/12. Reconnect restores the right thing ────────────────────────

  test('11. reconnect restores an unresolved prompt from the server', () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideId,
      'eventId': '$rideId:decision:1',
      'rideStatus': 'accepted',
      'stage': 'awaiting_decision',
      'title': 'Are you still heading to the passenger?',
      'body': 'The passenger is waiting.',
      'actions': ['still_coming', 'call_other_party', 'request_cancel'],
      'decisionOpen': true,
      'extensionsRemaining': 1,
      'respondByAt':
          DateTime.now().toUtc().add(const Duration(minutes: 2)).toIso8601String(),
    };

    await inject({'event': 'socket:reconnected'});
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.awaitingDecision);
    expect(c.needsAnswer, isTrue);
    // Resumed from the server's timestamp, not restarted.
    expect(c.secondsRemaining(DateTime.now().toUtc()), closeTo(120, 3));
  });

  test('12. reconnect does NOT restore a prompt the server has resolved',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    expect(controller.state.coordination!.needsAnswer, isTrue);

    api.coordination = null;
    await inject({'event': 'socket:reconnected'});
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(controller.state.coordination, isNull);
  });

  test('a decision this driver already answered comes back as answered',
      () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideId,
      'eventId': '$rideId:decision:1',
      'rideStatus': 'accepted',
      'stage': 'confirmed_en_route',
      'title': 'Passenger notified that you are still coming',
      'body': 'Please head to the pickup point.',
      'actions': ['call_other_party', 'open_navigation'],
      'decisionOpen': false,
      'decidedBy': 'driver',
      'decidedChoice': 'wait',
      'extensionsRemaining': 0,
    };

    await controller.refreshCoordination();

    final c = controller.state.coordination!;
    expect(c.decidedByMe, isTrue);
    expect(c.answered, isTrue);
    expect(c.needsAnswer, isFalse);
  });

  // ─── 13. Dedupe ───────────────────────────────────────────────────────

  test('13. the same prompt twice over the socket raises one prompt', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    await inject(decisionPrompt());
    await inject(decisionPrompt());

    expect(
        events.where((e) => e.$1 == 'coordination_prompt_displayed').length, 1);
  });

  test('13b. a push carrying the same eventId does not add a second prompt',
      () async {
    await arrangeOnAcceptedRide();
    notifications.deliver({
      'type': 'STALE_RIDE_DECISION',
      'rideId': rideId,
      'eventId': '$rideId:decision:1',
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    await inject(decisionPrompt(eventId: '$rideId:decision:1'));

    expect(
        events.where((e) => e.$1 == 'coordination_notification_displayed').length,
        1);
    expect(
        events.where((e) => e.$1 == 'coordination_prompt_displayed').length, 0);
  });

  // ─── 18. Both unresponsive ────────────────────────────────────────────

  test('18. a ride closed because neither party answered says so without '
      'blame, and offers a way back on the road', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideId,
      'reason': 'SYSTEM_ABANDONED_BY_BOTH',
      'systemCancelled': true,
      'outcome': 'closed_no_response',
      'title': 'Ride closed',
      'body': 'This ride was closed after neither party responded.',
    });

    expect(controller.state.closure, RideClosure.closedNoResponse);
    expect(controller.state.closureBody,
        'This ride was closed after neither party responded.');
    expect(controller.state.closure!.primaryAction, 'Go back online');
    expect(controller.state.closure!.isNoFault, isTrue);
    // And the driver is freed up.
    expect(controller.state.tripStep, TripStep.none);
    expect(controller.state.coordination, isNull);
  });

  test('a mere offer withdrawal needs no explanation', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideId,
      'outcome': 'offer_withdrawn',
    });

    // The driver never had this ride, so there is nothing to explain.
    expect(controller.state.closure, isNull);
    expect(controller.state.tripStep, TripStep.none);
  });

  test('a passenger cancellation is attributed to the passenger', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:cancelled',
      'rideId': rideId,
      'reason': 'passenger_cancelled',
      'outcome': 'cancelled_by_passenger',
      'title': 'Ride cancelled',
      'body': 'The passenger cancelled this ride. You can accept new rides now.',
    });

    expect(controller.state.closure, RideClosure.cancelledByPassenger);
    expect(controller.state.closureBody, contains('passenger cancelled'));
  });

  // ─── 19. Escalation ───────────────────────────────────────────────────

  test('19. escalation says a human has it and exposes no engineering codes',
      () async {
    await arrangeOnAcceptedRide(step: TripStep.arrived);
    await inject({
      'event': 'ride:delay_escalated',
      'rideId': rideId,
      'eventId': '$rideId:escalation:passenger_unreachable',
      'rideStatus': 'arrived',
      'delayState': 'passenger_offline',
      'unreachableParty': 'passenger',
      'title': 'Unable to reach the passenger',
      'body': 'We have not been able to contact them. Support has been notified. '
          'You can request to cancel.',
      'actions': ['request_cancel', 'call_passenger', 'continue_waiting'],
      'supportNotified': true,
    });

    final c = controller.state.coordination!;
    expect(c.stage, CoordinationStage.escalated);
    expect(c.escalatedToSupport, isTrue);
    expect(c.actions, contains(CoordinationAction.requestCancel));
    expect(c.actions, contains(CoordinationAction.callOtherParty));
    expect(c.title, isNot(contains('passenger_unreachable')));
    expect(c.body, isNot(contains('_')));
    // Escalation is explicitly NOT cancellation: the ride is alive.
    expect(controller.state.tripStep, TripStep.arrived);
  });

  // ─── 20. Network loss during response ─────────────────────────────────

  test('20. losing the network mid-response leaves the ride and the prompt '
      'intact', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    api.shouldFail = true;
    controller.respondToCoordination(CoordinationAction.stillComing);
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(controller.state.tripStep, TripStep.accepted);
    expect(controller.state.coordination, isNotNull);
    expect(controller.state.closure, isNull);

    await controller.refreshCoordination();
    expect(controller.state.coordination, isNotNull);
  });

  // ─── 21. Backend rejects a stale response ─────────────────────────────

  test('21. a refused response is reported honestly and the truth re-read',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.stillComing);

    api.coordination = null;
    await inject({
      'event': 'ride:stale_decision_ack',
      'rideId': rideId,
      'accepted': false,
      'reason': 'already_decided',
      'decidedBy': 'passenger',
      'decidedChoice': 'wait',
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(controller.state.errorMessage, contains('already answered'));
    expect(events.map((e) => e.$1), contains('coordination_response_rejected'));
    expect(api.coordinationCalls, greaterThan(0));
    expect(controller.state.coordination, isNull);
  });

  // ─── 22. Notification tap ─────────────────────────────────────────────

  test('22. a coordination push re-reads the state for THIS ride', () async {
    await arrangeOnAcceptedRide();
    api.coordination = {
      'rideId': rideId,
      'eventId': '$rideId:decision:1',
      'rideStatus': 'accepted',
      'stage': 'awaiting_decision',
      'title': 'Are you still heading to the passenger?',
      'body': 'The passenger is waiting.',
      'actions': ['still_coming', 'request_cancel'],
      'decisionOpen': true,
      'extensionsRemaining': 1,
    };

    notifications.deliver({
      'type': 'STALE_RIDE_DECISION',
      'rideId': rideId,
      'eventId': '$rideId:decision:1',
      'intent': 'active',
    });
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(api.coordinationCalls, greaterThan(0));
    expect(controller.state.coordination!.rideId, rideId);
    expect(controller.state.coordination!.stage,
        CoordinationStage.awaitingDecision);
  });

  // ─── 23/24. Accessibility and the no-silent-cancel invariant ──────────

  test('23. the accessibility label carries the situation and the countdown in '
      'words', () async {
    await arrangeOnAcceptedRide();
    // 150s, not 120: the label rounds DOWN, so a deadline exactly on the minute
    // boundary reads as "1 minute" the instant any time has elapsed.
    await inject(decisionPrompt(respondIn: const Duration(seconds: 150)));

    final label =
        controller.state.coordination!.accessibilityLabel(DateTime.now().toUtc());
    expect(label, contains('Are you still heading to the passenger?'));
    expect(label, contains('minutes left to respond'));
  });

  test('24. no driver action cancels a ride without the backend saying so',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    for (final action in CoordinationAction.values) {
      controller.respondToCoordination(action);
      if (controller.state.coordination != null) {
        await inject({
          'event': 'ride:stale_decision_ack',
          'rideId': rideId,
          'accepted': true,
          'choice': 'wait',
        });
      }
    }

    expect(controller.state.tripStep, TripStep.accepted);
    expect(controller.state.activeRequest, isNotNull);
    expect(controller.state.closure, isNull);
  });

  test('the app never invents a coordination state from silence', () async {
    await arrangeOnAcceptedRide();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(controller.state.coordination, isNull);
    expect(controller.state.closure, isNull);
    expect(controller.state.tripStep, TripStep.accepted);
  });

  test('coordination events for another ride are ignored', () async {
    await arrangeOnAcceptedRide();
    await inject({
      'event': 'ride:stale_decision_required',
      'rideId': 'RIDE-not-mine',
      'eventId': 'RIDE-not-mine:decision:1',
      'rideStatus': 'accepted',
      'title': 'Are you still heading to the passenger?',
      'options': ['wait', 'cancel'],
    });
    expect(controller.state.coordination, isNull);
  });

  test('a call is reported as activity so the server counts it as engagement',
      () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());

    controller.respondToCoordination(CoordinationAction.callOtherParty);

    final payload = sent('ride:activity')!.data as Map<String, dynamic>;
    expect(payload['type'], 'driver_called_passenger');
    expect(payload['role'], 'driver');
    expect(events.map((e) => e.$1), contains('coordination_call_used'));
    // Reporting a call must not consume the open question.
    expect(controller.state.coordination!.needsAnswer, isTrue);
  });

  test('analytics never carry message text or coordinates', () async {
    await arrangeOnAcceptedRide();
    await inject(decisionPrompt());
    controller.respondToCoordination(CoordinationAction.stillComing);

    for (final (name, params) in events) {
      if (!name.startsWith('coordination_')) continue;
      expect(params.containsKey('rideId'), isTrue, reason: name);
      expect(params.containsKey('stage'), isTrue, reason: name);
      expect(params['role'], 'driver', reason: name);
      expect(params.containsKey('timestamp'), isTrue, reason: name);
      expect(params.keys, isNot(contains('lat')));
      expect(params.keys, isNot(contains('lng')));
      expect(params.keys, isNot(contains('message')));
    }
  });
}
