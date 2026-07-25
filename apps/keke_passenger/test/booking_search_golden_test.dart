@Tags(['golden'])
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:keke_passenger/core/theme/app_theme.dart';
import 'package:keke_passenger/features/passenger/domain/booking_notice.dart';
import 'package:keke_passenger/features/passenger/domain/nearby_keke.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/booking_notice_card.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/searching_panel.dart';

/// Visual evidence for the search and outcome states. Regenerate with:
///   flutter test test/booking_search_golden_test.dart --update-goldens
/// Snapshots land in `test/goldens/`.
///
/// The app's text styles come from GoogleFonts, which cannot fetch anything
/// under `flutter test`. A local TTF is registered instead and
/// [AppTextStyles.debugFontOverride] points the styles at it, so GoogleFonts is
/// never asked and the snapshots show real glyphs rather than boxes.
const _goldenFontFamily = 'GoldenTestFont';

/// Fixed so snapshots are byte-stable across runs.
final _fixedExpiry = DateTime.utc(2030, 1, 1);

Future<void> _installTestFont() async {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
  final path =
      candidates.firstWhere((p) => File(p).existsSync(), orElse: () => '');
  if (path.isNotEmpty) {
    final bytes = File(path).readAsBytesSync();
    await (FontLoader(_goldenFontFamily)
          ..addFont(Future.value(ByteData.view(bytes.buffer))))
        .load();
  }
  AppTextStyles.debugFontOverride =
      const TextStyle(fontFamily: _goldenFontFamily);
}

/// Deliberately a plain theme: AppTheme.lightTheme also routes through
/// GoogleFonts. Each widget under test styles its own text via AppTextStyles.
Widget _frame(Widget child) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true, fontFamily: _goldenFontFamily),
      home: Scaffold(
        backgroundColor: AppColors.white,
        body: Center(
          child: Padding(padding: const EdgeInsets.all(20), child: child),
        ),
      ),
    );

/// 390 x [height] logical pixels — an iPhone-width booking sheet.
void _sizeViewport(WidgetTester tester, double height) {
  tester.view.devicePixelRatio = 2.0;
  tester.view.physicalSize = Size(390 * 2, height * 2);
  addTearDown(tester.view.reset);
}

void main() {
  setUpAll(_installTestFont);
  tearDownAll(() => AppTextStyles.debugFontOverride = null);

  testWidgets('golden: searching, first round', (tester) async {
    _sizeViewport(tester, 400);
    await tester.pumpWidget(_frame(SearchingPanel(onCancel: () {})));
    await tester.pump(const Duration(milliseconds: 400));

    await expectLater(find.byType(SearchingPanel),
        matchesGoldenFile('goldens/searching_round1.png'));
  });

  testWidgets('golden: searching, second round', (tester) async {
    _sizeViewport(tester, 400);
    await tester
        .pumpWidget(_frame(SearchingPanel(searchRound: 2, onCancel: () {})));
    await tester.pump(const Duration(milliseconds: 400));

    await expectLater(find.byType(SearchingPanel),
        matchesGoldenFile('goldens/searching_round2.png'));
  });

  testWidgets('golden: searching with nearby Kekes available', (tester) async {
    _sizeViewport(tester, 400);
    await tester.pumpWidget(_frame(SearchingPanel(
      onCancel: () {},
      nearbyKekes: NearbyKekeFeed(
        kekes: [
          NearbyKeke(key: 'a', position: const LatLng(6.21, 7.05), expiresAt: _fixedExpiry),
          NearbyKeke(key: 'b', position: const LatLng(6.22, 7.06), expiresAt: _fixedExpiry),
        ],
        eligibleCount: 3,
        approximateRadiusMeters: 120,
      ),
    )));
    await tester.pump(const Duration(milliseconds: 400));

    await expectLater(find.byType(SearchingPanel),
        matchesGoldenFile('goldens/searching_with_nearby.png'));
  });

  const cards = <String, RideOutcome>{
    'notice_drivers_busy': RideOutcome.noDriverAccepted,
    'notice_no_eligible_driver': RideOutcome.noEligibleDriver,
    'notice_request_expired': RideOutcome.requestExpired,
    'notice_active_ride': RideOutcome.activeRideExists,
    'notice_cancelled': RideOutcome.passengerCancelled,
    'notice_network_failed': RideOutcome.networkFailed,
    'notice_server_failed': RideOutcome.serverFailed,
    'notice_invalid_route': RideOutcome.invalidRoute,
  };

  cards.forEach((name, outcome) {
    testWidgets('golden: $name', (tester) async {
      _sizeViewport(tester, 420);
      await tester.pumpWidget(_frame(BookingNoticeCard(
        notice: BookingNotice.of(outcome),
        onSearchAgain: () {},
        onChangePickup: () {},
      )));
      await tester.pump();

      await expectLater(find.byType(BookingNoticeCard),
          matchesGoldenFile('goldens/$name.png'));
    });
  });
}
