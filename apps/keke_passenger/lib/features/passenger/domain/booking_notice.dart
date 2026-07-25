import 'package:flutter/material.dart';

/// Every distinct reason a ride request can stop short of an assigned driver.
///
/// These are deliberately separate: an *availability* outcome (no Keke free
/// right now) is not the same product event as a *failure* (no internet, server
/// error), and the passenger must never see the same message for both.
enum RideOutcome {
  /// Dispatch ran but found nobody eligible to ring around the pickup point.
  noEligibleDriver,

  /// Drivers were rung, but none of them accepted before dispatch gave up.
  noDriverAccepted,

  /// The request timed out — server dispatch window or client watchdog.
  requestExpired,

  /// The passenger cancelled the request themselves.
  passengerCancelled,

  /// The device could not reach the server (no data / socket down).
  networkFailed,

  /// The server accepted the connection but failed to process the request.
  serverFailed,

  /// Pickup and/or destination were rejected as unusable.
  invalidRoute,

  /// The passenger already has a live ride — a second booking is blocked.
  activeRideExists,
}

/// Visual weight of a notice. Red is reserved for [RideOutcomeTone.error];
/// availability outcomes are informational, not failures.
enum RideOutcomeTone { info, error }

extension RideOutcomeWire on RideOutcome {
  /// Stable string used on the wire and in analytics — never localise these.
  String get code {
    switch (this) {
      case RideOutcome.noEligibleDriver:
        return 'NO_ELIGIBLE_DRIVER';
      case RideOutcome.noDriverAccepted:
        return 'NO_DRIVER_ACCEPTED';
      case RideOutcome.requestExpired:
        return 'REQUEST_EXPIRED';
      case RideOutcome.passengerCancelled:
        return 'PASSENGER_CANCELLED';
      case RideOutcome.networkFailed:
        return 'NETWORK_FAILED';
      case RideOutcome.serverFailed:
        return 'SERVER_FAILED';
      case RideOutcome.invalidRoute:
        return 'INVALID_ROUTE';
      case RideOutcome.activeRideExists:
        return 'ACTIVE_RIDE_EXISTS';
    }
  }

  /// Parses a wire code emitted by the backend. Returns null for anything
  /// unrecognised so callers can pick their own fallback.
  static RideOutcome? fromCode(String? code) {
    if (code == null) return null;
    switch (code.toUpperCase()) {
      case 'NO_ELIGIBLE_DRIVER':
        return RideOutcome.noEligibleDriver;
      case 'NO_DRIVER_ACCEPTED':
        return RideOutcome.noDriverAccepted;
      case 'REQUEST_EXPIRED':
        return RideOutcome.requestExpired;
      case 'PASSENGER_CANCELLED':
        return RideOutcome.passengerCancelled;
      case 'NETWORK_FAILED':
        return RideOutcome.networkFailed;
      case 'INVALID_ROUTE':
      case 'INVALID_REQUEST':
        return RideOutcome.invalidRoute;
      case 'ACTIVE_RIDE_EXISTS':
      case 'ALREADY_ON_RIDE':
        return RideOutcome.activeRideExists;
      case 'SERVER_FAILED':
      case 'INTERNAL_ERROR':
      case 'RIDE_NOT_FOUND':
      case 'FORBIDDEN':
      case 'INVALID_STATE':
        return RideOutcome.serverFailed;
      default:
        return null;
    }
  }
}

/// The passenger-facing presentation of a [RideOutcome]: copy, tone, icon and
/// which recovery actions the card should offer.
@immutable
class BookingNotice {
  final RideOutcome outcome;
  final RideOutcomeTone tone;
  final String title;
  final String body;
  final IconData icon;
  final bool canSearchAgain;
  final bool canChangePickup;

  /// What dispatch actually did, when the server told us (e.g.
  /// `drivers_rung_none_accepted`). Analytics only — never shown.
  final String? dispatchResult;

  const BookingNotice({
    required this.outcome,
    required this.tone,
    required this.title,
    required this.body,
    required this.icon,
    this.canSearchAgain = false,
    this.canChangePickup = false,
    this.dispatchResult,
  });

  bool get isError => tone == RideOutcomeTone.error;

  /// Screen-reader label: tone is announced so a blind passenger gets the same
  /// "this is information, not a failure" signal the colour carries.
  String get semanticsLabel =>
      '${isError ? 'Error' : 'Information'}. $title. $body';

  BookingNotice withDispatchResult(String? result) => BookingNotice(
        outcome: outcome,
        tone: tone,
        title: title,
        body: body,
        icon: icon,
        canSearchAgain: canSearchAgain,
        canChangePickup: canChangePickup,
        dispatchResult: result,
      );

  /// The single source of truth for outcome → copy. Each case is distinct.
  factory BookingNotice.of(RideOutcome outcome, {String? dispatchResult}) {
    switch (outcome) {
      // ── Availability outcomes — informational, not errors ──────────────
      case RideOutcome.noEligibleDriver:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.info,
          title: 'No Keke nearby right now',
          body: 'We couldn\'t find an available Keke around your pickup point. '
              'Try again, or move your pickup closer to a main road.',
          icon: Icons.electric_rickshaw,
          canSearchAgain: true,
          canChangePickup: true,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.noDriverAccepted:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.info,
          title: 'Drivers are currently busy',
          body: 'We couldn\'t connect you with a nearby Keke just now. '
              'Please try again in a moment.',
          icon: Icons.access_time_rounded,
          canSearchAgain: true,
          canChangePickup: true,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.requestExpired:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.info,
          title: 'Your request timed out',
          body: 'We stopped searching after a while without a match. '
              'You can search again now.',
          icon: Icons.timer_off_rounded,
          canSearchAgain: true,
          canChangePickup: true,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.passengerCancelled:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.info,
          title: 'Request cancelled',
          body: 'You cancelled this ride request. '
              'Book again whenever you\'re ready.',
          icon: Icons.do_not_disturb_on_outlined,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.activeRideExists:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.info,
          title: 'You already have a ride in progress',
          body: 'Finish or cancel your current ride before booking another one.',
          icon: Icons.pending_actions_rounded,
          dispatchResult: dispatchResult,
        );

      // ── Real failures — red, because something is actually broken ──────
      case RideOutcome.networkFailed:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.error,
          title: 'No internet connection',
          body: 'Check your mobile data or Wi-Fi, then try again.',
          icon: Icons.wifi_off_rounded,
          canSearchAgain: true,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.serverFailed:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.error,
          title: 'Something went wrong on our end',
          body: 'We couldn\'t process your request. Please try again in a moment.',
          icon: Icons.cloud_off_rounded,
          canSearchAgain: true,
          dispatchResult: dispatchResult,
        );
      case RideOutcome.invalidRoute:
        return BookingNotice(
          outcome: outcome,
          tone: RideOutcomeTone.error,
          title: 'Check your pickup and destination',
          body: 'We couldn\'t use those locations. '
              'Set your pickup point and destination again.',
          icon: Icons.wrong_location_outlined,
          canChangePickup: true,
          dispatchResult: dispatchResult,
        );
    }
  }
}

/// Copy for the searching screen. Round 1 is the initial dispatch; round 2 is
/// the distinct "still looking" state used when a second dispatch round runs.
/// Deliberately carries no city name — see [SearchingCopy.of].
@immutable
class SearchingCopy {
  final String primary;
  final String supporting;

  const SearchingCopy({required this.primary, required this.supporting});

  /// [round] is 1-based. Anything >= 2 gets the second-round copy.
  ///
  /// No city or area name appears here on purpose: the passenger's city is not
  /// reliably known at request time (it was previously hardcoded to "Awka"),
  /// and naming the wrong city destroys trust in the whole search.
  factory SearchingCopy.of(int round) {
    if (round >= 2) {
      return const SearchingCopy(
        primary: 'Still searching nearby…',
        supporting: 'We\'re checking again for an available Keke driver.',
      );
    }
    return const SearchingCopy(
      primary: 'Finding a Keke near you…',
      supporting: 'Checking for available drivers close to your pickup point.',
    );
  }
}
