/// The delayed-ride and cancellation-decision state, as the server describes it.
///
/// A delay is not a failure. Two people are trying to meet in traffic, and the
/// app's job is to keep them talking — so nothing in this file is styled or
/// worded as an error, and nothing here decides that a ride has gone wrong.
///
/// Three rules the whole file exists to enforce:
///
///  1. **The server is authoritative.** Copy, permitted actions and deadlines all
///     arrive from the backend. The app does not decide whether "Keep waiting" is
///     still allowed, because the extension limit lives on the server and a
///     second copy of that rule here would eventually disagree with it — and
///     offering a button the backend will refuse is worse than not offering it.
///
///  2. **Deadlines are absolute.** [respondByAt] is a server timestamp, never a
///     local duration. A phone that has been asleep for two minutes resumes the
///     countdown where it actually is instead of restarting it.
///
///  3. **Every prompt has an identity.** [eventId] is deterministic server-side,
///     so a socket event and the push notification that follows it collapse to
///     one prompt, and a replay after reconnect cannot ask twice.
library;

/// What the passenger is being told. Coarser than the backend's nine operational
/// states — support needs to distinguish `driver_offline` from
/// `passenger_offline`, a passenger needs to know whether their driver is coming.
enum CoordinationStage {
  /// Ordinary ride. No coordination card is shown.
  none,

  /// Running late; nobody has been asked anything yet.
  runningLate,

  /// Both parties were asked; nobody has answered.
  awaitingDecision,

  /// Someone confirmed they are still coming.
  confirmedEnRoute,

  /// The driver is at the pickup point and waiting.
  waitingForPassenger,

  /// One party asked to cancel; the other has to answer.
  cancellationRequested,

  /// A human has this ride. Timers no longer act on it.
  escalated;

  static CoordinationStage fromWire(String? code) => switch (code) {
        'running_late' => CoordinationStage.runningLate,
        'awaiting_decision' => CoordinationStage.awaitingDecision,
        'confirmed_en_route' => CoordinationStage.confirmedEnRoute,
        'waiting_for_passenger' => CoordinationStage.waitingForPassenger,
        'cancellation_requested' => CoordinationStage.cancellationRequested,
        'escalated' => CoordinationStage.escalated,
        _ => CoordinationStage.none,
      };

  String get wire => switch (this) {
        CoordinationStage.none => 'none',
        CoordinationStage.runningLate => 'running_late',
        CoordinationStage.awaitingDecision => 'awaiting_decision',
        CoordinationStage.confirmedEnRoute => 'confirmed_en_route',
        CoordinationStage.waitingForPassenger => 'waiting_for_passenger',
        CoordinationStage.cancellationRequested => 'cancellation_requested',
        CoordinationStage.escalated => 'escalated',
      };
}

/// An action the server says this party may take right now.
///
/// Unknown values are dropped rather than rendered: a newer backend offering an
/// action this build has no handler for must not draw a dead button.
enum CoordinationAction {
  stillComing,
  keepWaiting,
  onMyWay,
  acceptCancellation,
  continueRide,
  requestCancel,
  findAnotherDriver,
  callOtherParty,
  messageOtherParty,
  contactSupport,
  shareLocation,
  openNavigation;

  static CoordinationAction? fromWire(String? code) => switch (code) {
        'still_coming' => CoordinationAction.stillComing,
        'keep_waiting' => CoordinationAction.keepWaiting,
        'continue_waiting' => CoordinationAction.keepWaiting,
        'on_my_way' => CoordinationAction.onMyWay,
        'accept_cancellation' => CoordinationAction.acceptCancellation,
        'continue_ride' => CoordinationAction.continueRide,
        'request_cancel' => CoordinationAction.requestCancel,
        'find_another_driver' => CoordinationAction.findAnotherDriver,
        'call_other_party' => CoordinationAction.callOtherParty,
        'call_driver' => CoordinationAction.callOtherParty,
        'call_passenger' => CoordinationAction.callOtherParty,
        'message_other_party' => CoordinationAction.messageOtherParty,
        'message_driver' => CoordinationAction.messageOtherParty,
        'message_passenger' => CoordinationAction.messageOtherParty,
        'contact_support' => CoordinationAction.contactSupport,
        'share_location' => CoordinationAction.shareLocation,
        'open_navigation' => CoordinationAction.openNavigation,
        _ => null,
      };

  /// The label the passenger reads. Plain language; no "stale", no "timeout".
  String get label => switch (this) {
        CoordinationAction.stillComing => "I'm still coming",
        CoordinationAction.keepWaiting => 'Continue waiting',
        CoordinationAction.onMyWay => "I'm coming",
        CoordinationAction.acceptCancellation => 'Accept cancellation',
        CoordinationAction.continueRide => 'Continue waiting',
        CoordinationAction.requestCancel => 'Cancel ride',
        CoordinationAction.findAnotherDriver => 'Find another Keke',
        CoordinationAction.callOtherParty => 'Call driver',
        CoordinationAction.messageOtherParty => 'Message driver',
        CoordinationAction.contactSupport => 'Contact support',
        CoordinationAction.shareLocation => 'Share my location',
        CoordinationAction.openNavigation => 'Open navigation',
      };

  /// True for actions that end the ride. These need a confirmation step and must
  /// never be the visually dominant or default-focused control.
  bool get isDestructive =>
      this == CoordinationAction.requestCancel ||
      this == CoordinationAction.acceptCancellation;
}

/// The immutable coordination state for the current ride.
class RideCoordination {
  final String rideId;
  final CoordinationStage stage;

  /// Server copy, rendered verbatim. The app does not compose these strings, so
  /// wording stays consistent with the driver app and with the push notification.
  final String title;
  final String body;

  final List<CoordinationAction> actions;

  /// Absolute server deadline for the open question, if any.
  final DateTime? respondByAt;

  /// Deterministic id for this coordination moment. Used to collapse a socket
  /// event and its push notification into one prompt.
  final String eventId;

  /// True while a decision prompt is open and unanswered. When false, an
  /// otherwise-identical prompt must not be re-shown.
  final bool decisionOpen;

  /// Who answered the decision prompt, once someone has. Either party may
  /// answer, and the first answer wins — so after a restart the app has to know
  /// whether the answer on record was this passenger's own.
  final String? decidedBy;

  /// This party's role, kept so [decidedByMe] can be answered without the caller
  /// having to remember which app it is.
  final String role;

  /// Who asked to cancel, when someone has.
  final String? cancellationRequestedBy;
  final String? cancellationRequestState;

  /// True when this party is the one who asked to cancel, so the UI shows a
  /// pending state rather than the answer buttons.
  final bool requestedByMe;

  /// How many "keep waiting" choices remain. Zero means the server would refuse.
  final int extensionsRemaining;

  final bool escalatedToSupport;

  /// The live ride status the server reported. Used to refuse to show any of this
  /// on a trip that is already under way.
  final String rideStatus;

  /// Set while a response is in flight, so a second tap cannot double-submit.
  final bool submitting;

  /// True once this party has answered and the server acknowledged it.
  final bool answered;

  /// Machine-readable situation, for analytics only. Never displayed.
  final String? reasonCode;

  const RideCoordination({
    required this.rideId,
    required this.stage,
    required this.title,
    required this.body,
    required this.eventId,
    this.role = 'passenger',
    this.decidedBy,
    this.actions = const [],
    this.respondByAt,
    this.decisionOpen = false,
    this.cancellationRequestedBy,
    this.cancellationRequestState,
    this.requestedByMe = false,
    this.extensionsRemaining = 0,
    this.escalatedToSupport = false,
    this.rideStatus = 'accepted',
    this.submitting = false,
    this.answered = false,
    this.reasonCode,
  });

  /// Parse a socket payload or the `coordination` block from the recovery
  /// endpoint. Returns null when there is nothing to show.
  ///
  /// [role] is this app's own role, so a cancellation request can be attributed
  /// to "me" or "the other person" — the two produce completely different UI.
  static RideCoordination? fromWire(
    Map<String, dynamic> data, {
    String role = 'passenger',
  }) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId.isEmpty) return null;

    final stage = _stageFor(data);
    if (stage == CoordinationStage.none) return null;

    // A trip already under way is never in a delayed-pickup conversation. The
    // backend only ever flags those for a human — it does not cancel them — so
    // showing a decision prompt would be describing something that cannot happen.
    final rideStatus = data['rideStatus']?.toString() ?? 'accepted';
    if (rideStatus != 'accepted' && rideStatus != 'arrived') return null;

    final title = data['title']?.toString();
    final body = data['body']?.toString();
    if (title == null || title.isEmpty) return null;

    final requestedBy = data['cancellationRequestedBy']?.toString() ??
        data['requestedBy']?.toString();

    return RideCoordination(
      rideId: rideId,
      stage: stage,
      title: title,
      body: body ?? '',
      // Fall back to a stage-derived key rather than a random one: two
      // deliveries of the same moment must produce the same id even on an older
      // server that sends none.
      eventId: data['eventId']?.toString() ?? '$rideId:${stage.wire}',
      actions: _actionsOf(data),
      respondByAt: _parseUtc(data['respondByAt']),
      decisionOpen: data['decisionOpen'] as bool? ??
          (stage == CoordinationStage.awaitingDecision),
      cancellationRequestedBy: requestedBy,
      cancellationRequestState: data['cancellationRequestState']?.toString(),
      role: role,
      decidedBy: data['decidedBy']?.toString(),
      requestedByMe: requestedBy != null && requestedBy == role,
      extensionsRemaining: (data['extensionsRemaining'] as num?)?.toInt() ?? 0,
      escalatedToSupport: data['escalatedToSupport'] as bool? ??
          (stage == CoordinationStage.escalated),
      rideStatus: rideStatus,
      reasonCode: data['reason']?.toString() ?? data['reasonCode']?.toString(),
    );
  }

  static CoordinationStage _stageFor(Map<String, dynamic> data) {
    // The recovery endpoint names the stage outright.
    final explicit = data['stage']?.toString();
    if (explicit != null) {
      final parsed = CoordinationStage.fromWire(explicit);
      if (parsed != CoordinationStage.none) return parsed;
    }
    // Socket events do not; each one means a specific stage.
    return switch (data['event']?.toString()) {
      'ride:stale_decision_required' => CoordinationStage.awaitingDecision,
      'ride:cancel_requested' => CoordinationStage.cancellationRequested,
      'ride:delay_escalated' => CoordinationStage.escalated,
      'ride:delay_notice' => _delayStageOf(data),
      'ride:delay_update' => _delayStageOf(data),
      _ => CoordinationStage.none,
    };
  }

  /// The reminder and warning events carry the operational `delayState`, which is
  /// finer-grained than the stages the passenger sees.
  static CoordinationStage _delayStageOf(Map<String, dynamic> data) {
    final delayState = data['delayState']?.toString();
    if (delayState == 'delayed_driver_confirmed_en_route') {
      return CoordinationStage.confirmedEnRoute;
    }
    if (delayState == 'waiting_for_passenger' ||
        data['rideStatus']?.toString() == 'arrived') {
      return CoordinationStage.waitingForPassenger;
    }
    return CoordinationStage.runningLate;
  }

  static List<CoordinationAction> _actionsOf(Map<String, dynamic> data) {
    final raw = data['actions'] ?? data['options'];
    if (raw is! List) return const [];
    final out = <CoordinationAction>[];
    for (final entry in raw) {
      // `options: ['wait','cancel']` is the decision prompt's older vocabulary.
      final mapped = switch (entry?.toString()) {
        'wait' => CoordinationAction.keepWaiting,
        'cancel' => CoordinationAction.requestCancel,
        final other => CoordinationAction.fromWire(other),
      };
      if (mapped != null && !out.contains(mapped)) out.add(mapped);
    }
    return out;
  }

  static DateTime? _parseUtc(Object? raw) {
    if (raw == null) return null;
    return DateTime.tryParse(raw.toString())?.toUtc();
  }

  /// Whole seconds left to answer, from a server timestamp. Null when there is no
  /// deadline; clamped at zero so an expired window never shows a negative count.
  int? secondsRemaining(DateTime now) {
    final deadline = respondByAt;
    if (deadline == null) return null;
    final left = deadline.difference(now.toUtc()).inSeconds;
    return left < 0 ? 0 : left;
  }

  /// True once the window has closed with no answer from this party. The ride is
  /// still active — only the backend ends it — so this drives copy, not state.
  bool hasExpired(DateTime now) {
    if (answered) return false;
    final left = secondsRemaining(now);
    return left != null && left == 0;
  }

  /// True when the answer on record is this party's own. After a restart this is
  /// the difference between "you already said you would wait" and "your driver
  /// did" — which are not the same thing to show someone.
  bool get decidedByMe => decidedBy != null && decidedBy == role;

  /// Whether this party still has a question in front of them.
  bool get needsAnswer {
    if (answered || submitting) return false;
    if (stage == CoordinationStage.cancellationRequested) return !requestedByMe;
    return decisionOpen && actions.isNotEmpty;
  }

  /// Whether the ride is in a state where offering "Continue waiting" is honest.
  bool get canKeepWaiting =>
      extensionsRemaining > 0 && actions.contains(CoordinationAction.keepWaiting);

  RideCoordination copyWith({
    CoordinationStage? stage,
    String? title,
    String? body,
    List<CoordinationAction>? actions,
    DateTime? respondByAt,
    bool clearRespondBy = false,
    String? eventId,
    bool? decisionOpen,
    String? decidedBy,
    String? cancellationRequestedBy,
    String? cancellationRequestState,
    bool? requestedByMe,
    int? extensionsRemaining,
    bool? escalatedToSupport,
    String? rideStatus,
    bool? submitting,
    bool? answered,
    String? reasonCode,
  }) {
    return RideCoordination(
      rideId: rideId,
      stage: stage ?? this.stage,
      title: title ?? this.title,
      body: body ?? this.body,
      eventId: eventId ?? this.eventId,
      role: role,
      decidedBy: decidedBy ?? this.decidedBy,
      actions: actions ?? this.actions,
      respondByAt: clearRespondBy ? null : (respondByAt ?? this.respondByAt),
      decisionOpen: decisionOpen ?? this.decisionOpen,
      cancellationRequestedBy:
          cancellationRequestedBy ?? this.cancellationRequestedBy,
      cancellationRequestState:
          cancellationRequestState ?? this.cancellationRequestState,
      requestedByMe: requestedByMe ?? this.requestedByMe,
      extensionsRemaining: extensionsRemaining ?? this.extensionsRemaining,
      escalatedToSupport: escalatedToSupport ?? this.escalatedToSupport,
      rideStatus: rideStatus ?? this.rideStatus,
      submitting: submitting ?? this.submitting,
      answered: answered ?? this.answered,
      reasonCode: reasonCode ?? this.reasonCode,
    );
  }

  /// A single sentence describing the whole card for a screen reader, so the
  /// state is understandable without seeing the map, the colour or the count.
  String accessibilityLabel(DateTime now) {
    final parts = <String>[title];
    if (body.isNotEmpty) parts.add(body);
    final left = secondsRemaining(now);
    if (left != null && !answered) {
      // Spoken in words. A countdown conveyed only by a shrinking number and a
      // colour is not conveyed at all.
      if (left == 0) {
        parts.add('Time to respond has passed.');
      } else if (left < 60) {
        parts.add('$left seconds left to respond.');
      } else {
        // Rounded DOWN, matching the visible countdown: never announce more time
        // than actually remains.
        final minutes = left ~/ 60;
        parts.add('$minutes ${minutes == 1 ? 'minute' : 'minutes'} left to respond.');
      }
    }
    if (submitting) parts.add('Sending your response.');
    if (answered) parts.add('Your response has been sent.');
    return parts.join(' ');
  }
}

/// How a ride ended, as the server classified it. The app never derives this —
/// reading "cancelled" as "the passenger cancelled" is how someone gets told they
/// cancelled a ride they did not.
enum RideClosure {
  cancelledByPassenger,
  cancelledByDriver,
  cancelledRequestUnanswered,
  closedNoResponse,
  resolvedBySupport,
  offerWithdrawn,
  cancelled;

  static RideClosure fromWire(String? outcome) => switch (outcome) {
        'cancelled_by_passenger' => RideClosure.cancelledByPassenger,
        'cancelled_by_driver' => RideClosure.cancelledByDriver,
        'cancelled_request_unanswered' => RideClosure.cancelledRequestUnanswered,
        'closed_no_response' => RideClosure.closedNoResponse,
        'resolved_by_support' => RideClosure.resolvedBySupport,
        'offer_withdrawn' => RideClosure.offerWithdrawn,
        _ => RideClosure.cancelled,
      };

  /// True when neither person did anything wrong and the copy must not imply
  /// they did.
  bool get isNoFault =>
      this == RideClosure.closedNoResponse ||
      this == RideClosure.cancelledRequestUnanswered;

  /// The action offered alongside the closing message.
  String get primaryAction => switch (this) {
        RideClosure.cancelledByPassenger => 'Find another Keke',
        RideClosure.cancelledByDriver => 'Find another Keke',
        RideClosure.cancelledRequestUnanswered => 'Find another Keke',
        RideClosure.closedNoResponse => 'Find another Keke',
        RideClosure.resolvedBySupport => 'Find another Keke',
        RideClosure.offerWithdrawn => 'Find another Keke',
        RideClosure.cancelled => 'Find another Keke',
      };
}
