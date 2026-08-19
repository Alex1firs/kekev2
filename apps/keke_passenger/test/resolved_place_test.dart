/// Structured pickup/destination capture.
///
/// The passenger app used to flatten a geocoder result into one string. That
/// string is what Ride Operations had to work from, and it frequently named no
/// place at all: a bare plus code, or the literal text "Location selected".
///
/// These tests are about two things: keeping the structure that was always
/// there, and never letting a geocoder failure affect a booking.
import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/features/passenger/domain/resolved_place.dart';

void main() {
  group('a resolved place keeps what the geocoder actually said', () {
    const awada = ResolvedPlace(
      address: '12 New Market Road',
      subLocality: 'Awada',
      locality: 'Obosi',
      city: 'Onitsha',
      state: 'Anambra',
    );

    test('the area line reads neighbourhood then town', () {
      expect(awada.areaLine, 'Awada, Obosi');
    });

    test('the request carries every field that resolved', () {
      expect(awada.toRequestFields('pickup'), {
        'pickupAddress': '12 New Market Road',
        'pickupSubLocality': 'Awada',
        'pickupLocality': 'Obosi',
        'pickupCity': 'Onitsha',
        'pickupState': 'Anambra',
      });
    });

    test('the destination prefix is applied to the same shape', () {
      expect(awada.toRequestFields('destination').keys, containsAll([
        'destinationAddress',
        'destinationSubLocality',
        'destinationLocality',
      ]));
    });
  });

  group('a partial geocode is not an error', () {
    test('omits keys for fields that did not resolve', () {
      // Absent, not empty. The backend then stores null, and a report can tell
      // "never captured" from "captured as blank".
      const partial = ResolvedPlace(address: 'Nweweka Street', subLocality: 'Awada');
      final f = partial.toRequestFields('pickup');
      expect(f.containsKey('pickupLocality'), isFalse);
      expect(f.containsKey('pickupCity'), isFalse);
      expect(f['pickupSubLocality'], 'Awada');
    });

    test('an area line with only one part is still useful', () {
      expect(const ResolvedPlace(address: 'x', subLocality: 'Awada').areaLine, 'Awada');
      expect(const ResolvedPlace(address: 'x', locality: 'Obosi').areaLine, 'Obosi');
    });

    test('no structured fields means no area line, not an empty string', () {
      // The UI shows its own fallback. Returning '' would render as a blank
      // area that looks like a bug.
      expect(const ResolvedPlace(address: 'x').areaLine, isNull);
    });
  });

  group('a failed geocode never poisons the record', () {
    test('the placeholder address is not sent as if it were a place', () {
      // "Location selected" is this function's failure return. It reached the
      // database and was rendered in the AREA column as though it named
      // somewhere. The key is omitted entirely instead.
      final f = ResolvedPlace.unresolved().toRequestFields('pickup');
      expect(f.containsKey('pickupAddress'), isFalse);
      expect(f, isEmpty);
    });

    test('every known placeholder is recognised', () {
      for (final p in ['Location selected', 'Unknown Location', 'Loading address...']) {
        expect(ResolvedPlace(address: p).isPlaceholder, isTrue, reason: p);
      }
    });

    test('a real address is never mistaken for a placeholder', () {
      expect(const ResolvedPlace(address: 'Upper Iweka').isPlaceholder, isFalse);
    });

    test('an unresolved place still has an address to show the passenger', () {
      // They picked a point on a map; the screen must say something.
      expect(ResolvedPlace.unresolved().address, isNotEmpty);
    });
  });
}
