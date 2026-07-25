import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/core/theme/app_theme.dart';
import 'package:keke_passenger/features/passenger/domain/booking_notice.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/booking_notice_card.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/searching_panel.dart';

/// Every city/area name the searching screen must never invent. "Awka" was
/// hardcoded into the supporting copy, so passengers in Onitsha were told the
/// app was searching a city they weren't in.
const _cityNames = ['Awka', 'Onitsha', 'Anambra', 'Nnewi', 'Enugu', 'Lagos'];

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.lightTheme,
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

/// The background colour of the notice card's own Container.
Color? _cardColor(WidgetTester tester) {
  final container = tester.widget<Container>(
    find
        .descendant(
          of: find.byType(BookingNoticeCard),
          matching: find.byType(Container),
        )
        .first,
  );
  return (container.decoration as BoxDecoration).color;
}

void main() {
  group('searching state copy', () {
    testWidgets('first round shows the pickup-relative copy', (tester) async {
      await tester.pumpWidget(_host(SearchingPanel(onCancel: () {})));

      expect(find.text('Finding a Keke near you…'), findsOneWidget);
      expect(
          find.text(
              'Checking for available drivers close to your pickup point.'),
          findsOneWidget);
      // The old copy is gone.
      expect(find.text('Finding your Keke…'), findsNothing);
    });

    testWidgets('second round shows the still-searching copy', (tester) async {
      await tester
          .pumpWidget(_host(SearchingPanel(searchRound: 2, onCancel: () {})));

      expect(find.text('Still searching nearby…'), findsOneWidget);
      expect(find.text('We\'re checking again for an available Keke driver.'),
          findsOneWidget);
      expect(find.text('Finding a Keke near you…'), findsNothing);
    });

    testWidgets('no city name is rendered in either round', (tester) async {
      for (final round in [1, 2]) {
        await tester.pumpWidget(
            _host(SearchingPanel(searchRound: round, onCancel: () {})));
        for (final city in _cityNames) {
          expect(find.textContaining(city), findsNothing,
              reason: 'round $round leaked the city name "$city"');
        }
      }
    });

    testWidgets('cancel request is wired and labelled for screen readers',
        (tester) async {
      var cancelled = false;
      await tester.pumpWidget(
          _host(SearchingPanel(onCancel: () => cancelled = true)));

      expect(
          tester.getSemantics(find.text('Cancel Request')).label,
          contains('Cancel this ride request'));

      await tester.tap(find.text('Cancel Request'));
      expect(cancelled, isTrue);
    });

    testWidgets('search status is a live region announcing both lines',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(SearchingPanel(onCancel: () {})));

      expect(
        find.bySemanticsLabel(
          'Finding a Keke near you… '
          'Checking for available drivers close to your pickup point.',
        ),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('a mid-search connection drop still uses error styling',
        (tester) async {
      await tester.pumpWidget(_host(SearchingPanel(
        onCancel: () {},
        transientMessage: 'Connection lost — your search continues in the '
            'background.',
      )));

      final container = tester.widget<Container>(find
          .ancestor(
            of: find.byIcon(Icons.wifi_off_rounded),
            matching: find.byType(Container),
          )
          .first);
      expect((container.decoration as BoxDecoration).color,
          AppColors.errorLight);
    });
  });

  group('no-driver availability state', () {
    testWidgets('renders the calm informational card, not a red error',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.noDriverAccepted),
        onSearchAgain: () {},
        onChangePickup: () {},
      )));

      expect(find.text('Drivers are currently busy'), findsOneWidget);
      expect(
        find.text('We couldn\'t connect you with a nearby Keke just now. '
            'Please try again in a moment.'),
        findsOneWidget,
      );
      // Calm cream surface, explicitly NOT the error red.
      expect(_cardColor(tester), AppColors.infoSurface);
      expect(_cardColor(tester), isNot(AppColors.errorLight));
      // The old red-card copy is gone for good.
      expect(
          find.textContaining('No drivers available right now'), findsNothing);
    });

    testWidgets('offers Search Again as primary and Change pickup as secondary',
        (tester) async {
      var searched = 0;
      var changedPickup = 0;
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.noDriverAccepted),
        onSearchAgain: () => searched++,
        onChangePickup: () => changedPickup++,
      )));

      await tester.tap(find.text('Search Again'));
      expect(searched, 1);

      await tester.tap(find.text('Change pickup point'));
      expect(changedPickup, 1);
    });

    testWidgets('actions carry accessible button labels', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.noDriverAccepted),
        onSearchAgain: () {},
        onChangePickup: () {},
      )));

      expect(find.bySemanticsLabel('Search again for a nearby Keke'),
          findsOneWidget);
      expect(find.bySemanticsLabel('Change your pickup point'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('no-eligible-driver reads differently from nobody-accepted',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.noEligibleDriver),
      )));

      expect(find.text('No Keke nearby right now'), findsOneWidget);
      expect(find.text('Drivers are currently busy'), findsNothing);
      expect(_cardColor(tester), AppColors.infoSurface);
    });

    testWidgets('an expired request is its own informational state',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.requestExpired),
      )));

      expect(find.text('Your request timed out'), findsOneWidget);
      expect(_cardColor(tester), AppColors.infoSurface);
    });
  });

  group('real failures keep the error treatment', () {
    testWidgets('network failure is red and offers a retry', (tester) async {
      var searched = 0;
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.networkFailed),
        onSearchAgain: () => searched++,
      )));

      expect(find.text('No internet connection'), findsOneWidget);
      expect(_cardColor(tester), AppColors.errorLight);
      expect(find.byIcon(Icons.wifi_off_rounded), findsOneWidget);

      await tester.tap(find.text('Search Again'));
      expect(searched, 1);
    });

    testWidgets('server failure is red and distinct from network failure',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.serverFailed),
      )));

      expect(find.text('Something went wrong on our end'), findsOneWidget);
      expect(find.text('No internet connection'), findsNothing);
      expect(_cardColor(tester), AppColors.errorLight);
    });

    testWidgets('invalid pickup/destination is red and only offers re-pick',
        (tester) async {
      var changedPickup = 0;
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.invalidRoute),
        onSearchAgain: () => fail('retrying the same bad locations is useless'),
        onChangePickup: () => changedPickup++,
      )));

      expect(find.text('Check your pickup and destination'), findsOneWidget);
      expect(_cardColor(tester), AppColors.errorLight);
      expect(find.text('Search Again'), findsNothing);

      await tester.tap(find.text('Change pickup point'));
      expect(changedPickup, 1);
    });
  });

  group('active ride protection', () {
    testWidgets('blocked booking explains itself without offering a retry',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.activeRideExists),
        // Even when the host supplies handlers, this outcome exposes neither.
        onSearchAgain: () => fail('must not offer a retry'),
        onChangePickup: () => fail('must not offer a pickup change'),
      )));

      expect(find.text('You already have a ride in progress'), findsOneWidget);
      expect(
          find.text(
              'Finish or cancel your current ride before booking another one.'),
          findsOneWidget);
      expect(find.text('Search Again'), findsNothing);
      expect(find.text('Change pickup point'), findsNothing);
      // Being blocked is a valid state, not an app failure.
      expect(_cardColor(tester), AppColors.infoSurface);
    });

    testWidgets('a cancelled request is not reported as a driver shortage',
        (tester) async {
      await tester.pumpWidget(_host(BookingNoticeCard(
        notice: BookingNotice.of(RideOutcome.passengerCancelled),
      )));

      expect(find.text('Request cancelled'), findsOneWidget);
      expect(find.textContaining('busy'), findsNothing);
      expect(find.textContaining('nearby'), findsNothing);
      expect(_cardColor(tester), AppColors.infoSurface);
    });
  });

  group('accessibility', () {
    testWidgets('every outcome announces its tone and full message',
        (tester) async {
      final handle = tester.ensureSemantics();
      for (final outcome in RideOutcome.values) {
        final notice = BookingNotice.of(outcome);
        await tester.pumpWidget(_host(BookingNoticeCard(notice: notice)));
        expect(find.bySemanticsLabel(notice.semanticsLabel), findsOneWidget,
            reason: '${outcome.code} has no accessible label');
      }
      handle.dispose();
    });

    testWidgets('no outcome card renders without a visible title and body',
        (tester) async {
      for (final outcome in RideOutcome.values) {
        final notice = BookingNotice.of(outcome);
        await tester.pumpWidget(_host(BookingNoticeCard(notice: notice)));
        expect(find.text(notice.title), findsOneWidget);
        expect(find.text(notice.body), findsOneWidget);
      }
    });
  });
}
