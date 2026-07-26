import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/core/theme/app_theme.dart';
import 'package:keke_passenger/features/passenger/domain/ride_coordination.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/coordination_card.dart';

/// Rendered snapshots of every passenger coordination state.
///
/// These double as the review artefact — running with `--update-goldens` writes
/// real PNGs of what a passenger sees at each stage, which is the only honest way
/// to check copy and hierarchy without a device in hand.
///
/// A locally installed sans font is registered as `KekeTestFont` and
/// [AppTextStyles.debugFontOverride] points the styles at it, so GoogleFonts is
/// never asked to fetch anything over a network that `flutter test` does not have.

const _fontCandidates = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

/// A fixed clock so a countdown renders identically on every run.
final _now = DateTime.utc(2026, 7, 26, 9, 20, 0);
DateTime _clock() => _now;

/// Phone-sized viewport. Physical pixels at DPR 2, so the logical width is 390 —
/// the figure that matters for layout, and the one an earlier golden got wrong by
/// setting 390 physical (195 logical) and manufacturing an overflow.
const _viewport = Size(390 * 2, 760 * 2);

/// Deliberately a plain theme: `AppTheme.lightTheme` also routes through
/// GoogleFonts, which tries to fetch over a network `flutter test` does not have.
/// Every widget here styles its own text through AppTextStyles, which the font
/// override above has already redirected.
Widget host(Widget child) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true, fontFamily: 'KekeTestFont'),
      home: Scaffold(
        backgroundColor: AppColors.snow,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: SingleChildScrollView(child: child),
          ),
        ),
      ),
    );

RideCoordination coordination({
  required CoordinationStage stage,
  required String title,
  required String body,
  required List<CoordinationAction> actions,
  DateTime? respondByAt,
  bool decisionOpen = true,
  int extensionsRemaining = 1,
  bool submitting = false,
  bool answered = false,
  bool requestedByMe = false,
  String? cancellationRequestedBy,
}) =>
    RideCoordination(
      rideId: 'RIDE-1785038873948',
      stage: stage,
      title: title,
      body: body,
      eventId: 'RIDE-1785038873948:decision:1',
      actions: actions,
      respondByAt: respondByAt,
      decisionOpen: decisionOpen,
      extensionsRemaining: extensionsRemaining,
      submitting: submitting,
      answered: answered,
      requestedByMe: requestedByMe,
      cancellationRequestedBy: cancellationRequestedBy,
    );

void main() {
  setUpAll(() async {
    final path = _fontCandidates.firstWhere((p) => File(p).existsSync(),
        orElse: () => '');
    if (path.isEmpty) return;
    final loader = FontLoader('KekeTestFont')
      ..addFont(Future.value(File(path).readAsBytesSync().buffer.asByteData()));
    await loader.load();
    AppTextStyles.debugFontOverride = const TextStyle(fontFamily: 'KekeTestFont');
  });

  tearDownAll(() => AppTextStyles.debugFontOverride = null);

  Future<void> snap(WidgetTester tester, String name, Widget child) async {
    tester.view.physicalSize = _viewport;
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(host(child));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/coordination_$name.png'),
    );
  }

  testWidgets('A — driver running late, awaiting their answer', (tester) async {
    await snap(
      tester,
      'passenger_awaiting_driver',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.awaitingDecision,
          title: 'Your driver is taking longer than expected',
          body: 'Waiting for your driver to confirm.',
          respondByAt: _now.add(const Duration(minutes: 2, seconds: 30)),
          actions: const [
            CoordinationAction.keepWaiting,
            CoordinationAction.callOtherParty,
            CoordinationAction.requestCancel,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('B — driver confirmed en route', (tester) async {
    await snap(
      tester,
      'passenger_driver_confirmed',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.confirmedEnRoute,
          title: 'Your driver confirmed they are still coming',
          body: 'They are on their way to the pickup point.',
          decisionOpen: false,
          answered: true,
          actions: const [
            CoordinationAction.keepWaiting,
            CoordinationAction.callOtherParty,
            CoordinationAction.requestCancel,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('C — driver unreachable, escalated to support', (tester) async {
    await snap(
      tester,
      'passenger_driver_unreachable',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.escalated,
          title: "We haven't been able to reach your driver",
          body: 'Our team has been notified. You can look for another Keke, '
              'or keep waiting.',
          decisionOpen: false,
          actions: const [
            CoordinationAction.findAnotherDriver,
            CoordinationAction.contactSupport,
            CoordinationAction.callOtherParty,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('D — driver arrived, passenger asked if they are coming',
      (tester) async {
    await snap(
      tester,
      'passenger_driver_waiting',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.waitingForPassenger,
          title: 'Your driver is waiting',
          body: 'Please meet your driver at the pickup point.',
          respondByAt: _now.add(const Duration(minutes: 3)),
          actions: const [
            CoordinationAction.onMyWay,
            CoordinationAction.callOtherParty,
            CoordinationAction.requestCancel,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('E — driver asked to cancel, passenger must answer',
      (tester) async {
    await snap(
      tester,
      'passenger_cancel_requested_by_driver',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.cancellationRequested,
          title: 'Your driver requested to cancel this ride',
          body: 'You can accept, or ask them to keep coming.',
          respondByAt: _now.add(const Duration(minutes: 2)),
          cancellationRequestedBy: 'driver',
          actions: const [
            CoordinationAction.acceptCancellation,
            CoordinationAction.continueRide,
            CoordinationAction.callOtherParty,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('F — the passenger asked; waiting on the driver', (tester) async {
    await snap(
      tester,
      'passenger_cancel_pending',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.cancellationRequested,
          title: 'Waiting for a response to your cancellation',
          body: 'We have asked your driver. Your ride stays active until they answer.',
          respondByAt: _now.add(const Duration(minutes: 2)),
          requestedByMe: true,
          cancellationRequestedBy: 'passenger',
          decisionOpen: false,
          actions: const [CoordinationAction.callOtherParty],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('G — the window closed with no answer', (tester) async {
    await snap(
      tester,
      'passenger_decision_expired',
      CoordinationCard(
        clock: _clock,
        coordination: coordination(
          stage: CoordinationStage.awaitingDecision,
          title: 'Your driver is taking longer than expected',
          body: 'Waiting for your driver to confirm.',
          respondByAt: _now.subtract(const Duration(minutes: 4)),
          actions: const [
            CoordinationAction.keepWaiting,
            CoordinationAction.callOtherParty,
            CoordinationAction.requestCancel,
          ],
        ),
        onAction: (_) {},
      ),
    );
  });

  testWidgets('H — the ride was closed because nobody answered', (tester) async {
    await snap(
      tester,
      'passenger_closed_no_response',
      RideClosedCard(
        title: 'Ride closed',
        body: "This ride was closed because we couldn't reach either you or "
            'the driver.',
        closure: RideClosure.closedNoResponse,
        onPrimaryAction: () {},
      ),
    );
  });
}
