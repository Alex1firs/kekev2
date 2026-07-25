import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Regression guard for the "Connecting to nearby Keke drivers in Awka" bug:
/// the searching screen named a city that had nothing to do with the
/// passenger's pickup coordinates, so passengers in Onitsha were told the app
/// was searching Awka.
///
/// The files below own all search/outcome copy. None of them may name a place —
/// if a city ever belongs on screen it must be resolved from live pickup
/// coordinates, not written into a widget.
///
/// (The landmark rail in `booking_sheet.dart` is deliberately out of scope: its
/// city names are real data attached to real coordinates.)
void main() {
  const copyOwningFiles = [
    'lib/features/passenger/domain/booking_notice.dart',
    'lib/features/passenger/presentation/widgets/searching_panel.dart',
    'lib/features/passenger/presentation/widgets/booking_notice_card.dart',
  ];

  const placeNames = [
    'Awka',
    'Onitsha',
    'Anambra',
    'Nnewi',
    'Enugu',
    'Lagos',
    'Abuja',
  ];

  for (final path in copyOwningFiles) {
    test('$path hardcodes no place name', () {
      final file = File(path);
      // Fail loudly rather than vacuously passing if the file moves.
      expect(file.existsSync(), isTrue,
          reason: '$path not found — update this guard if the file moved');

      final source = file.readAsStringSync();
      for (final place in placeNames) {
        // The explanatory comments in these files reference the old bug by
        // name; only code lines are checked.
        final offenders = source
            .split('\n')
            .where((line) => !line.trimLeft().startsWith('//'))
            .where((line) => line.contains(place))
            .toList();
        expect(offenders, isEmpty,
            reason: '$path names "$place" outside a comment: $offenders');
      }
    });
  }
}
