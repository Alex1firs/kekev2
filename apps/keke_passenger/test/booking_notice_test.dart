import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/core/services/analytics_service.dart';
import 'package:keke_passenger/features/passenger/domain/booking_notice.dart';

void main() {
  group('SearchingCopy', () {
    test('round 1 uses the pickup-relative copy', () {
      final copy = SearchingCopy.of(1);
      expect(copy.primary, 'Finding a Keke near you…');
      expect(copy.supporting,
          'Checking for available drivers close to your pickup point.');
    });

    test('round 2 uses the distinct still-searching copy', () {
      final copy = SearchingCopy.of(2);
      expect(copy.primary, 'Still searching nearby…');
      expect(copy.supporting,
          'We\'re checking again for an available Keke driver.');
    });

    test('rounds beyond 2 stay on the second-round copy', () {
      expect(SearchingCopy.of(5).primary, SearchingCopy.of(2).primary);
    });

    test('no city or area name leaks into any round', () {
      // "Awka" was hardcoded here for every passenger regardless of location.
      const banned = ['Awka', 'Onitsha', 'Anambra', 'Nnewi', 'Lagos'];
      for (final round in [1, 2, 3]) {
        final copy = SearchingCopy.of(round);
        for (final city in banned) {
          expect(copy.primary, isNot(contains(city)));
          expect(copy.supporting, isNot(contains(city)));
        }
      }
    });
  });

  group('BookingNotice tone separation', () {
    test('availability outcomes are informational, never errors', () {
      for (final outcome in [
        RideOutcome.noEligibleDriver,
        RideOutcome.noDriverAccepted,
        RideOutcome.requestExpired,
        RideOutcome.passengerCancelled,
        RideOutcome.activeRideExists,
        RideOutcome.outsideServiceArea,
      ]) {
        expect(BookingNotice.of(outcome).tone, RideOutcomeTone.info,
            reason: '${outcome.code} must not use error styling');
      }
    });

    test('real failures keep the error tone', () {
      for (final outcome in [
        RideOutcome.networkFailed,
        RideOutcome.serverFailed,
        RideOutcome.invalidRoute,
      ]) {
        expect(BookingNotice.of(outcome).tone, RideOutcomeTone.error,
            reason: '${outcome.code} is a real failure');
      }
    });

    test('all nine outcomes have distinct titles and bodies', () {
      final titles = <String>{};
      final bodies = <String>{};
      for (final outcome in RideOutcome.values) {
        final notice = BookingNotice.of(outcome);
        expect(titles.add(notice.title), isTrue,
            reason: 'duplicate title for ${outcome.code}: ${notice.title}');
        expect(bodies.add(notice.body), isTrue,
            reason: 'duplicate body for ${outcome.code}');
      }
      expect(RideOutcome.values.length, 9);
    });

    test('the no-driver availability copy is the agreed product copy', () {
      final notice = BookingNotice.of(RideOutcome.noDriverAccepted);
      expect(notice.title, 'Drivers are currently busy');
      expect(
        notice.body,
        'We couldn\'t connect you with a nearby Keke just now. '
        'Please try again in a moment.',
      );
      expect(notice.canSearchAgain, isTrue);
      expect(notice.canChangePickup, isTrue);
    });

    test('no notice copy mentions a city', () {
      for (final outcome in RideOutcome.values) {
        final notice = BookingNotice.of(outcome);
        expect(notice.title, isNot(contains('Awka')));
        expect(notice.body, isNot(contains('Awka')));
      }
    });

    test('active-ride block offers no retry — retrying cannot help', () {
      final notice = BookingNotice.of(RideOutcome.activeRideExists);
      expect(notice.canSearchAgain, isFalse);
      expect(notice.canChangePickup, isFalse);
      expect(notice.title, 'You already have a ride in progress');
    });

    group('outside the service area', () {
      /*
       * The gap this closes: OUTSIDE_SERVICE_AREA was not a wire code the app
       * knew, so it fell through to serverFailed and a passenger standing in
       * Kano was told something had gone wrong on our end and to try again in
       * a moment. Nothing had gone wrong, and trying again could never work.
       */
      test('the wire code maps to its own outcome, not to a server failure', () {
        expect(RideOutcomeWire.fromCode('OUTSIDE_SERVICE_AREA'),
            RideOutcome.outsideServiceArea);
        expect(RideOutcomeWire.fromCode('OUTSIDE_SERVICE_AREA'),
            isNot(RideOutcome.serverFailed));
      });

      test('it reads as information about the PLACE, not a fault or a ban', () {
        final notice = BookingNotice.of(RideOutcome.outsideServiceArea);
        expect(notice.tone, RideOutcomeTone.info);
        expect(notice.isError, isFalse);
        // Nothing in the copy may suggest the person is at fault or barred.
        final text = '${notice.title} ${notice.body}'.toLowerCase();
        for (final word in ['blocked', 'banned', 'not allowed', 'denied',
                            'went wrong', 'error', 'unauthorised']) {
          expect(text, isNot(contains(word)),
              reason: 'the passenger is not blocked — the pickup is out of range');
        }
      });

      test('it offers a new pickup, and does NOT offer a pointless retry', () {
        final notice = BookingNotice.of(RideOutcome.outsideServiceArea);
        expect(notice.canSearchAgain, isFalse,
            reason: 'searching again from the same pin can never succeed');
        expect(notice.canChangePickup, isTrue,
            reason: 'moving the pickup is the only thing that can help');
      });
    });

    test('semantics label announces tone so it survives colour blindness', () {
      expect(BookingNotice.of(RideOutcome.noDriverAccepted).semanticsLabel,
          startsWith('Information.'));
      expect(BookingNotice.of(RideOutcome.networkFailed).semanticsLabel,
          startsWith('Error.'));
    });
  });

  group('wire code mapping', () {
    test('round-trips every outcome through its own code', () {
      for (final outcome in RideOutcome.values) {
        expect(RideOutcomeWire.fromCode(outcome.code), outcome);
      }
    });

    test('maps the backend dispatch outcome codes', () {
      expect(RideOutcomeWire.fromCode('NO_ELIGIBLE_DRIVER'),
          RideOutcome.noEligibleDriver);
      expect(RideOutcomeWire.fromCode('NO_DRIVER_ACCEPTED'),
          RideOutcome.noDriverAccepted);
      expect(RideOutcomeWire.fromCode('REQUEST_EXPIRED'),
          RideOutcome.requestExpired);
    });

    test('maps the backend ride:error codes', () {
      expect(RideOutcomeWire.fromCode('ACTIVE_RIDE_EXISTS'),
          RideOutcome.activeRideExists);
      expect(RideOutcomeWire.fromCode('ALREADY_ON_RIDE'),
          RideOutcome.activeRideExists);
      expect(RideOutcomeWire.fromCode('INTERNAL_ERROR'),
          RideOutcome.serverFailed);
      expect(RideOutcomeWire.fromCode('RIDE_NOT_FOUND'),
          RideOutcome.serverFailed);
      expect(RideOutcomeWire.fromCode('INVALID_REQUEST'),
          RideOutcome.invalidRoute);
    });

    test('unknown and missing codes return null so callers pick a fallback', () {
      expect(RideOutcomeWire.fromCode(null), isNull);
      expect(RideOutcomeWire.fromCode('SOMETHING_NEW'), isNull);
    });
  });

  group('AnalyticsService', () {
    test('ride outcome event carries id, code, dispatch result, attempts, ts',
        () {
      final events = <List<Object?>>[];
      final analytics = AnalyticsService(
        sink: (event, params) => events.add([event, params]),
        clock: () => DateTime.utc(2026, 7, 25, 12, 30, 5),
      );

      analytics.logRideOutcome(
        rideId: 'RIDE-123',
        outcome: RideOutcome.noDriverAccepted,
        dispatchResult: 'drivers_rung_none_accepted',
        searchAttempts: 2,
      );

      expect(events, hasLength(1));
      expect(events.single[0], 'passenger_ride_outcome');
      final params = events.single[1] as Map<String, Object?>;
      expect(params['rideId'], 'RIDE-123');
      expect(params['outcomeCode'], 'NO_DRIVER_ACCEPTED');
      expect(params['dispatchResult'], 'drivers_rung_none_accepted');
      expect(params['searchAttempts'], 2);
      expect(params['tone'], 'info');
      expect(params['timestamp'], '2026-07-25T12:30:05.000Z');
    });

    test('error outcomes are tagged with the error tone', () {
      final events = <Map<String, Object?>>[];
      AnalyticsService(sink: (_, p) => events.add(p)).logRideOutcome(
        rideId: 'RIDE-9',
        outcome: RideOutcome.networkFailed,
        searchAttempts: 1,
      );
      expect(events.single['tone'], 'error');
      expect(events.single['outcomeCode'], 'NETWORK_FAILED');
    });

    test('search-started event records the attempt and round', () {
      final events = <List<Object?>>[];
      AnalyticsService(sink: (e, p) => events.add([e, p])).logSearchStarted(
        rideId: 'RIDE-7',
        searchAttempts: 2,
        searchRound: 2,
      );
      expect(events.single[0], 'passenger_ride_search_started');
      final params = events.single[1] as Map<String, Object?>;
      expect(params['searchAttempts'], 2);
      expect(params['searchRound'], 2);
    });
  });
}
