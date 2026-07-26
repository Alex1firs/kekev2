import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/core/theme/app_theme.dart';
import 'package:keke_passenger/features/passenger/domain/ride_coordination.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/coordination_card.dart';

/// What the delayed-ride card actually renders.
///
/// The rules being enforced here are product rules, not styling preferences:
/// a coordination state must not look like an error, a destructive action must be
/// confirmed and must not be the default, and the countdown must be legible to
/// someone who cannot see colour.

/// Colours the card must never use as its surface. A delayed ride is a fact about
/// traffic; dressing it in red teaches passengers to panic at ordinary lateness.
const _errorColours = [AppColors.error, AppColors.errorLight];

Widget host(Widget child) => MaterialApp(
      theme: AppTheme.lightTheme,
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

RideCoordination coordination({
  CoordinationStage stage = CoordinationStage.awaitingDecision,
  String title = 'Your driver is taking longer than expected',
  String body = 'Waiting for your driver to confirm.',
  List<CoordinationAction> actions = const [
    CoordinationAction.keepWaiting,
    CoordinationAction.callOtherParty,
    CoordinationAction.requestCancel,
  ],
  DateTime? respondByAt,
  bool decisionOpen = true,
  int extensionsRemaining = 1,
  bool submitting = false,
  bool answered = false,
  bool requestedByMe = false,
  String? cancellationRequestedBy,
}) =>
    RideCoordination(
      rideId: 'RIDE-1',
      stage: stage,
      title: title,
      body: body,
      eventId: 'RIDE-1:decision:1',
      actions: actions,
      respondByAt: respondByAt,
      decisionOpen: decisionOpen,
      extensionsRemaining: extensionsRemaining,
      submitting: submitting,
      answered: answered,
      requestedByMe: requestedByMe,
      cancellationRequestedBy: cancellationRequestedBy,
    );

Color? cardColour(WidgetTester tester) {
  final container = tester.widget<Container>(
    find
        .descendant(
            of: find.byType(CoordinationCard), matching: find.byType(Container))
        .first,
  );
  return (container.decoration as BoxDecoration).color;
}

void main() {
  // GoogleFonts cannot fetch a font under `flutter test`; the fallback metrics
  // are enough for these assertions and keep the suite offline.
  setUpAll(() => AppTextStyles.debugFontOverride = const TextStyle());
  tearDownAll(() => AppTextStyles.debugFontOverride = null);

  // ─── 1/2. The delayed prompt renders ───────────────────────────────────

  testWidgets('1. the delayed-driver prompt renders its title, body and the '
      'permitted actions', (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    expect(find.text('Your driver is taking longer than expected'),
        findsOneWidget);
    expect(find.text('Waiting for your driver to confirm.'), findsOneWidget);
    expect(find.text('Continue waiting'), findsOneWidget);
    expect(find.text('Call driver'), findsOneWidget);
    expect(find.text('Cancel ride'), findsOneWidget);
  });

  testWidgets('it is styled as a coordination state, never as an error',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    // Cream surface, amber border. Not red.
    expect(cardColour(tester), AppColors.infoSurface);
    expect(_errorColours, isNot(contains(cardColour(tester))));
  });

  testWidgets('no technical vocabulary reaches the screen', (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          respondByAt: DateTime.now().toUtc().add(const Duration(minutes: 2)),
        ),
        onAction: (_) {},
      ),
    ));

    for (final banned in [
      'stale',
      'Stale',
      'timeout',
      'Timeout',
      'heartbeat',
      'socket',
      'system recovery',
      'driver_never_arrived',
      'SYSTEM_',
    ]) {
      expect(find.textContaining(banned), findsNothing, reason: banned);
    }
  });

  // ─── Countdown ─────────────────────────────────────────────────────────

  testWidgets('the countdown is spelled out, not conveyed by colour alone',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          respondByAt: DateTime.now().toUtc().add(const Duration(seconds: 135)),
        ),
        onAction: (_) {},
      ),
    ));

    final countdown =
        tester.widget<Text>(find.byKey(const Key('coordination-countdown')));
    // Words, so a screen reader and a colour-blind passenger get the same
    // information a sighted one does.
    expect(countdown.data, contains('left to respond'));
    expect(countdown.data, contains('minutes'));
  });

  testWidgets('an elapsed window says the time has passed rather than showing '
      'a negative count', (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          respondByAt: DateTime.now().toUtc().subtract(const Duration(minutes: 5)),
        ),
        onAction: (_) {},
      ),
    ));

    final countdown =
        tester.widget<Text>(find.byKey(const Key('coordination-countdown')));
    expect(countdown.data, 'Time to respond has passed');
    expect(countdown.data, isNot(contains('-')));
    // And it says the ride is still alive, because it is.
    expect(find.byKey(const Key('coordination-expired')), findsOneWidget);
    expect(find.textContaining('still active'), findsOneWidget);
  });

  testWidgets('there is no countdown when the server set no deadline',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));
    expect(find.byKey(const Key('coordination-countdown')), findsNothing);
  });

  // ─── Destructive actions ───────────────────────────────────────────────

  testWidgets('cancelling asks for confirmation before anything is sent',
      (tester) async {
    final chosen = <CoordinationAction>[];
    await tester.pumpWidget(host(
      CoordinationCard(
          coordination: coordination(), onAction: chosen.add),
    ));

    await tester.tap(find.byKey(
        const Key('coordination-action-requestCancel')));
    await tester.pumpAndSettle();

    // Nothing has been sent yet — a mis-tap must not lose someone their ride.
    expect(chosen, isEmpty);
    expect(find.text('Cancel this ride?'), findsOneWidget);

    await tester.tap(find.text('Keep the ride'));
    await tester.pumpAndSettle();
    expect(chosen, isEmpty);
  });

  testWidgets('confirming the cancellation does send it', (tester) async {
    final chosen = <CoordinationAction>[];
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: chosen.add),
    ));

    await tester
        .tap(find.byKey(const Key('coordination-action-requestCancel')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Cancel ride'));
    await tester.pumpAndSettle();

    expect(chosen, [CoordinationAction.requestCancel]);
  });

  testWidgets('a non-destructive action fires immediately, with no dialog',
      (tester) async {
    final chosen = <CoordinationAction>[];
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: chosen.add),
    ));

    await tester.tap(find.byKey(const Key('coordination-action-keepWaiting')));
    await tester.pumpAndSettle();

    expect(chosen, [CoordinationAction.keepWaiting]);
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('the destructive action is last and is not focusable by default',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    final cancel = tester.widget<ExcludeFocus>(find.descendant(
      of: find.byKey(const Key('coordination-action-requestCancel')),
      matching: find.byType(ExcludeFocus),
    ));
    expect(cancel.excluding, isTrue);

    final keep = tester.widget<ExcludeFocus>(find.descendant(
      of: find.byKey(const Key('coordination-action-keepWaiting')),
      matching: find.byType(ExcludeFocus),
    ));
    expect(keep.excluding, isFalse);

    // And ordered so the safe action comes first on screen.
    final keepY = tester
        .getTopLeft(find.byKey(const Key('coordination-action-keepWaiting')))
        .dy;
    final cancelY = tester
        .getTopLeft(find.byKey(const Key('coordination-action-requestCancel')))
        .dy;
    expect(keepY, lessThan(cancelY));
  });

  testWidgets('every action target is at least 44dp tall', (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    for (final action in [
      CoordinationAction.keepWaiting,
      CoordinationAction.callOtherParty,
      CoordinationAction.requestCancel,
    ]) {
      final size =
          tester.getSize(find.byKey(Key('coordination-action-${action.name}')));
      expect(size.height, greaterThanOrEqualTo(44.0), reason: action.name);
    }
  });

  // ─── Submitting / answered / extension limit ────────────────────────────

  testWidgets('a response in flight hides the actions and says it is sending',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
          coordination: coordination(submitting: true), onAction: (_) {}),
    ));

    expect(find.byKey(const Key('coordination-submitting')), findsOneWidget);
    expect(find.byKey(const Key('coordination-action-keepWaiting')),
        findsNothing);
    expect(
        find.byKey(const Key('coordination-action-requestCancel')), findsNothing);
  });

  testWidgets('an answered prompt confirms it was sent', (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(answered: true, decisionOpen: false),
        onAction: (_) {},
      ),
    ));
    expect(find.byKey(const Key('coordination-answered')), findsOneWidget);
  });

  testWidgets('Continue waiting is not drawn when no extensions remain',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(extensionsRemaining: 0),
        onAction: (_) {},
      ),
    ));

    // Offering a button the server would refuse is a lie to the person holding
    // the phone.
    expect(find.byKey(const Key('coordination-action-keepWaiting')),
        findsNothing);
    expect(find.text('Continue waiting'), findsNothing);
    // The other actions survive.
    expect(find.text('Call driver'), findsOneWidget);
  });

  // ─── Cancellation request states ────────────────────────────────────────

  testWidgets('the requester sees a pending state, not answer buttons',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          stage: CoordinationStage.cancellationRequested,
          title: 'Waiting for a response to your cancellation',
          body: 'We have asked your driver.',
          requestedByMe: true,
          cancellationRequestedBy: 'passenger',
          actions: const [CoordinationAction.callOtherParty],
          decisionOpen: false,
        ),
        onAction: (_) {},
      ),
    ));

    expect(
        find.byKey(const Key('coordination-pending-request')), findsOneWidget);
    expect(find.textContaining('stays active until they answer'), findsOneWidget);
    expect(find.text('Accept cancellation'), findsNothing);
  });

  testWidgets('the other party sees who asked and both ways to answer',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          stage: CoordinationStage.cancellationRequested,
          title: 'Your driver requested to cancel this ride',
          body: 'You can accept, or ask them to keep coming.',
          cancellationRequestedBy: 'driver',
          actions: const [
            CoordinationAction.acceptCancellation,
            CoordinationAction.continueRide,
            CoordinationAction.callOtherParty,
          ],
        ),
        onAction: (_) {},
      ),
    ));

    expect(find.text('Your driver requested to cancel this ride'),
        findsOneWidget);
    expect(find.text('Accept cancellation'), findsOneWidget);
    expect(find.text('Continue waiting'), findsOneWidget);
    // Accepting a cancellation ends a ride, so it is confirmed too.
    await tester
        .tap(find.byKey(const Key('coordination-action-acceptCancellation')));
    await tester.pumpAndSettle();
    expect(find.text('Accept the cancellation?'), findsOneWidget);
  });

  // ─── 19. Escalation ────────────────────────────────────────────────────

  testWidgets('19. the escalated state offers support and a way forward',
      (tester) async {
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          stage: CoordinationStage.escalated,
          title: 'This ride needs support assistance',
          body: 'We have not been able to reach your driver. '
              'Our team has been notified.',
          actions: const [
            CoordinationAction.findAnotherDriver,
            CoordinationAction.contactSupport,
            CoordinationAction.callOtherParty,
          ],
          decisionOpen: false,
        ),
        onAction: (_) {},
      ),
    ));

    expect(find.text('This ride needs support assistance'), findsOneWidget);
    expect(find.text('Find another Keke'), findsOneWidget);
    expect(find.text('Contact support'), findsOneWidget);
    // Still not an error surface.
    expect(cardColour(tester), AppColors.infoSurface);
  });

  // ─── 18. The both-unresponsive closing card ────────────────────────────

  testWidgets('18. the closed-ride card explains without blaming anyone',
      (tester) async {
    var tapped = 0;
    await tester.pumpWidget(host(
      RideClosedCard(
        title: 'Ride closed',
        body: "This ride was closed because we couldn't reach either you or "
            'the driver.',
        closure: RideClosure.closedNoResponse,
        onPrimaryAction: () => tapped++,
      ),
    ));

    expect(
        find.textContaining("couldn't reach either you or the driver"),
        findsOneWidget);
    expect(find.text('Find another Keke'), findsOneWidget);
    // No blame words anywhere.
    for (final banned in ['no-show', 'No-show', 'failed', 'Failed', 'fault']) {
      expect(find.textContaining(banned), findsNothing, reason: banned);
    }

    await tester.tap(find.byKey(const Key('ride-closed-primary')));
    await tester.pump();
    expect(tapped, 1);
  });

  testWidgets('the closed-ride card is neutral, not red', (tester) async {
    await tester.pumpWidget(host(
      RideClosedCard(
        title: 'Ride closed',
        body: 'This ride was closed after nobody responded.',
        closure: RideClosure.closedNoResponse,
        onPrimaryAction: () {},
      ),
    ));

    final container = tester.widget<Container>(find
        .descendant(
            of: find.byType(RideClosedCard), matching: find.byType(Container))
        .first);
    final colour = (container.decoration as BoxDecoration).color;
    expect(_errorColours, isNot(contains(colour)));
  });

  // ─── 23. Accessibility ─────────────────────────────────────────────────

  testWidgets('23. the card is one labelled node carrying the whole situation',
      (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(host(
      CoordinationCard(
        coordination: coordination(
          respondByAt: DateTime.now().toUtc().add(const Duration(seconds: 150)),
        ),
        onAction: (_) {},
      ),
    ));

    // Situation, detail and remaining time announced together, so it is
    // understandable with no map and no glance at a colour.
    expect(
      find.bySemanticsLabel(RegExp(
          r'Your driver is taking longer than expected.*minutes left to respond')),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('every action exposes a button semantics label', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    expect(find.bySemanticsLabel('Continue waiting'), findsOneWidget);
    expect(find.bySemanticsLabel('Call driver'), findsOneWidget);
    expect(find.bySemanticsLabel('Cancel ride'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('the prompt is understandable with no map present', (tester) async {
    // The card is rendered on its own — no GoogleMap, no driver marker, no ETA.
    await tester.pumpWidget(host(
      CoordinationCard(coordination: coordination(), onAction: (_) {}),
    ));

    expect(find.text('Your driver is taking longer than expected'),
        findsOneWidget);
    expect(find.text('Waiting for your driver to confirm.'), findsOneWidget);
    expect(find.text('Continue waiting'), findsOneWidget);
  });
}
