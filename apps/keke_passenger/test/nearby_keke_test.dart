import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:keke_passenger/core/theme/app_theme.dart';
import 'package:keke_passenger/features/passenger/domain/nearby_keke.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/nearby_keke_layer.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/searching_panel.dart';

const _awka = LatLng(6.2097, 7.0562);

NearbyKeke _keke(String key, {LatLng? at, Duration ttl = const Duration(seconds: 20)}) =>
    NearbyKeke(
      key: key,
      position: at ?? _awka,
      expiresAt: DateTime.now().add(ttl),
    );

/// Server payload shape, so parsing is tested against the real contract.
Map<String, dynamic> _payload({
  required List<Map<String, dynamic>> markers,
  int? eligibleCount,
  int approx = 120,
  int round = 1,
  double radius = 2,
}) =>
    {
      'rideId': 'RIDE-1',
      'dispatchRound': round,
      'searchRadiusKm': radius,
      'markers': markers,
      'eligibleCount': eligibleCount ?? markers.length,
      'approximateRadiusMeters': approx,
      'refreshAfterMs': 8000,
    };

Map<String, dynamic> _marker(String key, {double lat = 6.21, double lng = 7.05, int? expiresAt}) => {
      'key': key,
      'lat': lat,
      'lng': lng,
      'expiresAt': expiresAt ??
          DateTime.now().add(const Duration(seconds: 20)).millisecondsSinceEpoch,
    };

void main() {
  group('feed parsing — only eligible drivers are ever drawn', () {
    test('parses exactly what the server sent, adding nothing', () {
      final feed = NearbyKekeFeed.fromJson(
        _payload(markers: [_marker('aaa'), _marker('bbb')]),
        now: DateTime.now(),
      );

      expect(feed.kekes.map((k) => k.key), ['aaa', 'bbb']);
      expect(feed.eligibleCount, 2);
      expect(feed.dispatchRound, 1);
      expect(feed.approximateRadiusMeters, 120);
    });

    test('an empty server response yields no markers and no simulated supply', () {
      final feed = NearbyKekeFeed.fromJson(
        _payload(markers: [], eligibleCount: 0),
        now: DateTime.now(),
      );

      expect(feed.kekes, isEmpty);
      expect(feed.isEmpty, isTrue);
      expect(feed.eligibleCount, 0);
      expect(feed.shortLabel, 'Checking for Kekes nearby…');
    });

    test('malformed marker entries are dropped, not guessed at', () {
      final feed = NearbyKekeFeed.fromJson(
        {
          'markers': [
            _marker('good'),
            {'key': 'no-coords'},
            {'lat': 6.2, 'lng': 7.0}, // no key
            'garbage',
          ],
          'eligibleCount': 4,
        },
        now: DateTime.now(),
      );

      expect(feed.kekes.map((k) => k.key), ['good']);
    });

    test('the reported count never falls below the markers actually drawn', () {
      // A server under-reporting its count must not produce "0 nearby" text
      // while two markers sit on the map.
      final feed = NearbyKekeFeed.fromJson(
        _payload(markers: [_marker('a'), _marker('b')], eligibleCount: 0),
        now: DateTime.now(),
      );
      expect(feed.eligibleCount, greaterThanOrEqualTo(feed.kekes.length));
    });

    test('a capped marker list still reports the honest total', () {
      final feed = NearbyKekeFeed.fromJson(
        _payload(markers: [_marker('a'), _marker('b')], eligibleCount: 9),
        now: DateTime.now(),
      );
      expect(feed.kekes, hasLength(2));
      expect(feed.eligibleCount, 9);
      expect(feed.shortLabel, '9 Kekes nearby');
    });

    test('carries no identifying driver information', () {
      final feed = NearbyKekeFeed.fromJson(
        _payload(markers: [_marker('aaa')]),
        now: DateTime.now(),
      );
      final keke = feed.kekes.single;
      // The model has room for a key, a position and an expiry — nothing else.
      expect(keke.key, 'aaa');
      expect(keke.position, isA<LatLng>());
      expect(keke.expiresAt, isA<DateTime>());
    });
  });

  group('stale markers are excluded', () {
    test('expired markers are pruned', () {
      final now = DateTime.now();
      final feed = NearbyKekeFeed(
        kekes: [
          NearbyKeke(key: 'fresh', position: _awka, expiresAt: now.add(const Duration(seconds: 10))),
          NearbyKeke(key: 'stale', position: _awka, expiresAt: now.subtract(const Duration(seconds: 1))),
        ],
        eligibleCount: 2,
      );

      final pruned = feed.prunedAt(now);
      expect(pruned.kekes.map((k) => k.key), ['fresh']);
    });

    test('pruning everything also zeroes the count — no orphan "2 nearby"', () {
      final now = DateTime.now();
      final feed = NearbyKekeFeed(
        kekes: [
          NearbyKeke(key: 'a', position: _awka, expiresAt: now.subtract(const Duration(seconds: 1))),
        ],
        eligibleCount: 2,
      );

      final pruned = feed.prunedAt(now);
      expect(pruned.kekes, isEmpty);
      expect(pruned.eligibleCount, 0);
      expect(pruned.shortLabel, 'Checking for Kekes nearby…');
    });

    test('a marker exactly at its expiry is treated as stale', () {
      final now = DateTime.now();
      final keke = NearbyKeke(key: 'edge', position: _awka, expiresAt: now);
      expect(keke.isExpiredAt(now), isTrue);
    });
  });

  group('marker layer — no flicker, smooth add and remove', () {
    test('keys markers by the server handle, not list position', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);

      layer.update([_keke('alpha'), _keke('beta')]);
      final first = layer.markers(icon: BitmapDescriptor.defaultMarker).map((m) => m.markerId.value).toSet();

      // Same drivers, reversed order — previously index-keyed markers would all
      // move, which is exactly what made the map flicker.
      layer.update([_keke('beta'), _keke('alpha')]);
      final second = layer.markers(icon: BitmapDescriptor.defaultMarker).map((m) => m.markerId.value).toSet();

      expect(first, second);
      expect(first, {'nearby_keke_alpha', 'nearby_keke_beta'});
    });

    test('a persisting marker keeps its identity across refreshes', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);

      layer.update([_keke('same', at: const LatLng(6.20, 7.05))]);
      layer.update([_keke('same', at: const LatLng(6.21, 7.06))]);

      final markers = layer.markers(icon: BitmapDescriptor.defaultMarker);
      expect(markers, hasLength(1));
      expect(markers.single.markerId.value, 'nearby_keke_same');
    });

    test('a driver that becomes ineligible is removed', () async {
      final layer = NearbyKekeLayer(
        tweenSteps: 2,
        tweenDuration: const Duration(milliseconds: 20),
      );
      addTearDown(layer.dispose);

      layer.update([_keke('stays'), _keke('goes')]);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(layer.trackedKeys, containsAll(['stays', 'goes']));

      layer.update([_keke('stays')]);
      // Fades out first…
      expect(layer.trackedKeys, contains('goes'));
      // …then is gone.
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(layer.trackedKeys, ['stays']);
    });

    test('new markers fade in rather than popping into place', () {
      final layer = NearbyKekeLayer(tweenSteps: 4);
      addTearDown(layer.dispose);

      layer.update([_keke('newcomer')]);
      final marker = layer.markers(icon: BitmapDescriptor.defaultMarker).single;
      expect(marker.alpha, lessThan(1.0));
    });

    test('markers settle at full opacity once the transition ends', () async {
      final layer = NearbyKekeLayer(
        tweenSteps: 2,
        tweenDuration: const Duration(milliseconds: 20),
      );
      addTearDown(layer.dispose);

      layer.update([_keke('settles')]);
      await Future<void>.delayed(const Duration(milliseconds: 80));

      expect(layer.markers(icon: BitmapDescriptor.defaultMarker).single.alpha, 1.0);
      expect(layer.isAnimating, isFalse);
    });

    test('clear() drops everything immediately, with no lingering fade', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);

      layer.update([_keke('a'), _keke('b')]);
      layer.clear();

      expect(layer.trackedCount, 0);
      expect(layer.markers(icon: BitmapDescriptor.defaultMarker), isEmpty);
    });

    test('markers are not tappable — there is nothing to inspect', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);

      layer.update([_keke('anon')]);
      final marker = layer.markers(icon: BitmapDescriptor.defaultMarker).single;
      expect(marker.consumeTapEvents, isTrue);
      expect(marker.infoWindow.title, isNull);
    });

    test('nearby markers sit below the assigned-driver marker', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);
      layer.update([_keke('anon')]);
      // The assigned driver draws at zIndex 2 in home_map_screen.
      expect(layer.markers(icon: BitmapDescriptor.defaultMarker).single.zIndex, 1.0);
    });
  });

  group('performance on low-end devices', () {
    test('stops ticking as soon as a transition completes', () async {
      final layer = NearbyKekeLayer(
        tweenSteps: 2,
        tweenDuration: const Duration(milliseconds: 20),
      );
      addTearDown(layer.dispose);

      layer.update([_keke('a')]);
      expect(layer.isAnimating, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      // Idle between refreshes: no timer, no rebuilds, no battery burn.
      expect(layer.isAnimating, isFalse);
    });

    test('an empty update stops the timer instead of spinning', () {
      final layer = NearbyKekeLayer(tweenSteps: 4);
      addTearDown(layer.dispose);

      layer.update([]);
      expect(layer.isAnimating, isFalse);
      expect(layer.trackedCount, 0);
    });

    test('holds a bounded marker set and rebuilds no bitmaps', () {
      final layer = NearbyKekeLayer(tweenSteps: 0);
      addTearDown(layer.dispose);

      // Even a larger-than-expected feed stays cheap and bounded.
      layer.update(List.generate(20, (i) => _keke('k$i')));
      final icon = BitmapDescriptor.defaultMarker;
      final markers = layer.markers(icon: icon);

      expect(markers, hasLength(20));
      // One shared cached bitmap for every marker — no per-marker decode.
      expect(markers.every((m) => m.icon == icon), isTrue);
    });

    test('repeated updates do not accumulate tracked markers', () async {
      final layer = NearbyKekeLayer(
        tweenSteps: 2,
        tweenDuration: const Duration(milliseconds: 10),
      );
      addTearDown(layer.dispose);

      for (var i = 0; i < 12; i++) {
        layer.update([_keke('rotating_$i')]);
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }

      // Only the current marker survives; departed ones are evicted.
      expect(layer.trackedCount, 1);
      expect(layer.trackedKeys, ['rotating_11']);
    });

    test('disposal cancels the timer', () async {
      final layer = NearbyKekeLayer(tweenSteps: 20);
      layer.update([_keke('a')]);
      expect(layer.isAnimating, isTrue);
      layer.dispose();
      expect(layer.isAnimating, isFalse);
    });
  });

  group('accessibility-safe alternative', () {
    Widget host(Widget child) => MaterialApp(
          theme: AppTheme.lightTheme,
          home: Scaffold(body: SingleChildScrollView(child: child)),
        );

    testWidgets('availability is stated as text, not only as map markers',
        (tester) async {
      await tester.pumpWidget(host(SearchingPanel(
        onCancel: () {},
        nearbyKekes: NearbyKekeFeed(
          kekes: [_keke('a'), _keke('b')],
          eligibleCount: 3,
          approximateRadiusMeters: 120,
        ),
      )));

      expect(find.text('3 Kekes nearby'), findsOneWidget);
      // Honest about precision.
      expect(find.textContaining('approximate'), findsOneWidget);
    });

    testWidgets('screen readers get the count as a live region', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(host(SearchingPanel(
        onCancel: () {},
        nearbyKekes: NearbyKekeFeed(
          kekes: [_keke('a')],
          eligibleCount: 1,
          approximateRadiusMeters: 120,
        ),
      )));

      expect(
        find.bySemanticsLabel(
            '1 available Keke near your pickup point. Positions are approximate.'),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('the empty state says so plainly instead of implying supply',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(host(SearchingPanel(onCancel: () {})));

      expect(find.text('Checking for Kekes nearby…'), findsOneWidget);
      expect(
        find.bySemanticsLabel('No available Kekes nearby yet. Still checking.'),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('the summary never claims a driver was contacted', (tester) async {
      await tester.pumpWidget(host(SearchingPanel(
        onCancel: () {},
        nearbyKekes: NearbyKekeFeed(
          kekes: [_keke('a')],
          eligibleCount: 2,
          approximateRadiusMeters: 120,
        ),
      )));

      for (final claim in ['offered', 'notified', 'contacted', 'accepted', 'assigned']) {
        expect(find.textContaining(claim), findsNothing,
            reason: 'a nearby marker must not imply "$claim"');
      }
    });

    testWidgets('availability text appears in both dispatch rounds', (tester) async {
      for (final round in [1, 2]) {
        await tester.pumpWidget(host(SearchingPanel(
          onCancel: () {},
          searchRound: round,
          nearbyKekes: NearbyKekeFeed(kekes: [_keke('a')], eligibleCount: 1),
        )));
        expect(find.text('1 Keke nearby'), findsOneWidget,
            reason: 'round $round lost the availability summary');
      }
    });
  });
}
