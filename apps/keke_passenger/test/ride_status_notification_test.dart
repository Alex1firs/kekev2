/// The persistent Android ride notification.
///
/// The wording is the part a passenger actually reads on a lock screen, so
/// `copyFor` is pure and tested directly. The plugin calls themselves need a
/// platform channel and are exercised only for their safety properties: they
/// must never throw, and they must never post for a state that is not a live
/// ride.

import 'package:flutter_test/flutter_test.dart';

import 'package:keke_passenger/core/services/ride_status_notification.dart';
import 'package:keke_passenger/features/passenger/domain/booking_state.dart';

void main() {
  final n = RideStatusNotification.instance;

  setUp(() {
    n.debugReset();
    // No platform channels in a unit test.
    RideStatusNotification.platformSupported = () => false;
  });

  tearDown(() {
    RideStatusNotification.platformSupported = () => false;
  });

  // ══════════════════════════════════════════════════════════════════
  //  What the passenger reads
  // ══════════════════════════════════════════════════════════════════

  group('copy for a live ride', () {
    test('a driver on the way is named', () {
      final c = RideStatusNotification.copyFor(
        BookingStep.confirmed,
        driverName: 'Chidi Okeke',
        destination: 'UNIZIK Gate',
      )!;
      expect(c.title, 'Chidi Okeke is on the way');
      expect(c.body, contains('UNIZIK Gate'));
    });

    test('arrival is unambiguous', () {
      final c = RideStatusNotification.copyFor(
        BookingStep.arrived,
        driverName: 'Chidi Okeke',
      )!;
      expect(c.title, 'Chidi Okeke has arrived');
      expect(c.body, contains('pickup'));
    });

    test('a trip in progress says so', () {
      final c = RideStatusNotification.copyFor(
        BookingStep.started,
        destination: 'UNIZIK Gate',
      )!;
      expect(c.title, 'Trip in progress');
      expect(c.body, contains('UNIZIK Gate'));
    });

    test('searching is shown too — the passenger is waiting on us', () {
      final c = RideStatusNotification.copyFor(BookingStep.searching)!;
      expect(c.title, 'Finding you a Keke');
    });

    test('a missing driver name degrades to "Your driver", never to blank', () {
      for (final name in [null, '', '   ']) {
        final c = RideStatusNotification.copyFor(
          BookingStep.confirmed,
          driverName: name,
        )!;
        expect(c.title, 'Your driver is on the way');
        expect(c.title, isNot(contains('null')));
      }
    });

    test('a missing destination still produces a usable line', () {
      final c = RideStatusNotification.copyFor(BookingStep.started)!;
      expect(c.body, isNotEmpty);
      expect(c.body, isNot(contains('null')));
    });

    test('no copy ever contains a placeholder or an empty segment', () {
      for (final step in BookingStep.values) {
        final c = RideStatusNotification.copyFor(step,
            driverName: null, destination: null);
        if (c == null) continue;
        expect(c.title.trim(), isNotEmpty);
        expect(c.body.trim(), isNotEmpty);
        expect('${c.title} ${c.body}', isNot(contains('null')));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  When nothing should be shown
  // ══════════════════════════════════════════════════════════════════

  group('states that are not a live ride show nothing', () {
    /*
     * A stale notification after a ride ends is the failure mode this has to
     * avoid: it tells a passenger they have a Keke coming when they do not.
     */
    for (final step in [
      BookingStep.loading,
      BookingStep.idle,
      BookingStep.selectingPickup,
      BookingStep.selectingDestination,
      BookingStep.selectingDestinationOnMap,
      BookingStep.previewEstimate,
      BookingStep.completed,
    ]) {
      test('$step shows nothing', () {
        expect(RideStatusNotification.copyFor(step), isNull);
      });
    }

    test('completed is treated as terminal, not as a live trip', () {
      // A receipt is not a ride. This is the state a finished trip lands in,
      // and leaving the entry up would be the stale notification above.
      expect(RideStatusNotification.copyFor(BookingStep.completed), isNull);
    });

    test('every BookingStep is classified — none falls through', () {
      // If a step is added and not handled, the switch will not compile. This
      // asserts the runtime half: no step throws.
      for (final step in BookingStep.values) {
        expect(() => RideStatusNotification.copyFor(step), returnsNormally);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Safety
  // ══════════════════════════════════════════════════════════════════

  group('it can never break a ride', () {
    test('show() on an unsupported platform is a silent no-op', () async {
      await expectLater(
        n.show(BookingStep.confirmed, driverName: 'Chidi'),
        completes,
      );
    });

    test('clear() is idempotent and safe when nothing is showing', () async {
      await expectLater(n.clear(), completes);
      await expectLater(n.clear(), completes);
    });

    test('a terminal state clears rather than posting', () async {
      await n.show(BookingStep.completed);
      expect(n.debugShownKey, isNull);
    });

    test('initialize() on an unsupported platform does not throw', () async {
      await expectLater(n.initialize(), completes);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Identity
  // ══════════════════════════════════════════════════════════════════

  group('one entry, never two', () {
    test('the notification id is fixed so a post updates rather than stacks', () {
      // Two live-ride entries for one passenger would be worse than none.
      expect(RideStatusNotification.notificationId, 8001);
    });

    test('the channel is separate from the alerting ride channels', () {
      // keke_ride_updates carries the loud lifecycle pushes. This one is a
      // silent status line; sharing a channel would make it buzz on every
      // update, or make the alerts silent.
      expect(RideStatusNotification.channelId, 'keke_ride_status');
      expect(RideStatusNotification.channelId, isNot('keke_ride_updates'));
      expect(RideStatusNotification.channelId, isNot('keke_ride_requests'));
    });

    test('the tap payload carries no ride state', () {
      // It must not be possible to render a ride from the payload. The tap
      // triggers a server read; the payload only says "something ride-shaped
      // was tapped".
      expect(RideStatusNotification.tapPayload, 'active_ride');
      expect(RideStatusNotification.tapPayload, isNot(contains('RIDE-')));
    });
  });
}
