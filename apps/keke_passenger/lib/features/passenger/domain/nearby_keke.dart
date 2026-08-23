import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

/// One anonymous, approximated nearby Keke shown on the passenger map.
///
/// Carries no driver identity by design — the server sends an opaque [key] that
/// is stable only within a single ride. That stability is what lets the map
/// animate the same marker between refreshes instead of tearing every marker
/// down and rebuilding it (which is what made markers flicker).
@immutable
class NearbyKeke {
  /// Opaque server-side handle. NOT a driver id.
  final String key;

  /// Approximated position — see [NearbyKekeFeed.approximateRadiusMeters].
  final LatLng position;

  /// After this moment the marker is no longer trustworthy and must be dropped,
  /// even if no fresh feed has arrived (e.g. the connection dropped).
  final DateTime expiresAt;

  const NearbyKeke({
    required this.key,
    required this.position,
    required this.expiresAt,
  });

  bool isExpiredAt(DateTime now) => !now.isBefore(expiresAt);

  NearbyKeke copyWith({LatLng? position, DateTime? expiresAt}) => NearbyKeke(
        key: key,
        position: position ?? this.position,
        expiresAt: expiresAt ?? this.expiresAt,
      );

  static NearbyKeke? tryParse(Object? raw, {required DateTime fallbackExpiry}) {
    if (raw is! Map) return null;
    final key = raw['key']?.toString();
    final lat = (raw['lat'] as num?)?.toDouble();
    final lng = (raw['lng'] as num?)?.toDouble();
    if (key == null || key.isEmpty || lat == null || lng == null) return null;
    final expiryMs = (raw['expiresAt'] as num?)?.toInt();
    return NearbyKeke(
      key: key,
      position: LatLng(lat, lng),
      expiresAt: expiryMs != null
          ? DateTime.fromMillisecondsSinceEpoch(expiryMs)
          : fallbackExpiry,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is NearbyKeke &&
      other.key == key &&
      other.position.latitude == position.latitude &&
      other.position.longitude == position.longitude &&
      other.expiresAt == expiresAt;

  @override
  int get hashCode =>
      Object.hash(key, position.latitude, position.longitude, expiresAt);
}

/// A snapshot of nearby supply, with the honest counts behind it.
@immutable
class NearbyKekeFeed {
  final List<NearbyKeke> kekes;

  /// Eligible drivers the server actually found — may exceed [kekes].length,
  /// which is capped for privacy and map performance. This is the number the
  /// accessible text summary reports, so it is never inflated.
  final int eligibleCount;

  /// How coarse the positions are, so the UI can avoid implying precision.
  final int approximateRadiusMeters;

  /// Which dispatch round produced this snapshot.
  final int dispatchRound;

  /// The search radius dispatch is currently working, in km.
  final double? searchRadiusKm;

  const NearbyKekeFeed({
    this.kekes = const [],
    this.eligibleCount = 0,
    this.approximateRadiusMeters = 0,
    this.dispatchRound = 1,
    this.searchRadiusKm,
  });

  static const empty = NearbyKekeFeed();

  bool get isEmpty => kekes.isEmpty;

  /// Drops markers whose expiry has passed. Used when a refresh fails so the map
  /// ages out rather than reassuring the passenger with unverifiable supply.
  NearbyKekeFeed prunedAt(DateTime now) {
    final live = kekes.where((k) => !k.isExpiredAt(now)).toList();
    if (live.length == kekes.length) return this;
    return NearbyKekeFeed(
      kekes: live,
      // The count must not outlive the markers it described.
      eligibleCount: live.isEmpty ? 0 : eligibleCount,
      approximateRadiusMeters: approximateRadiusMeters,
      dispatchRound: dispatchRound,
      searchRadiusKm: searchRadiusKm,
    );
  }

  /// Screen-reader/summary text. Truthful about approximation, and never claims
  /// a driver has been contacted.
  String get accessibilitySummary {
    if (eligibleCount <= 0) {
      return 'No available Kekes nearby yet. Still checking.';
    }
    final noun = eligibleCount == 1 ? 'Keke' : 'Kekes';
    return '$eligibleCount available $noun near your pickup point. '
        'Positions are approximate.';
  }

  /// Short on-screen label for the same information.
  String get shortLabel {
    if (eligibleCount <= 0) return 'Checking for Kekes nearby…';
    return eligibleCount == 1
        ? '1 Keke nearby'
        : '$eligibleCount Kekes nearby';
  }

  /// Straight-line metres to the closest live marker, or null when a number
  /// would be misleading.
  ///
  /// ── Why this returns null so readily ────────────────────────────────
  /// Marker positions are deliberately fuzzed by [approximateRadiusMeters]
  /// for driver privacy. Below roughly that distance the "nearest" figure is
  /// reporting the fuzz, not the driver, and a passenger watching it jump
  /// between 80 m and 400 m learns not to believe anything on the screen.
  ///
  /// This is also deliberately a DISTANCE and never a time. We have no road
  /// network and no traffic data here, so any minutes figure would be a
  /// straight line divided by a guess — which in Onitsha, with its one-way
  /// streets and market congestion, is fiction. Distance is what the data
  /// honestly supports.
  int? nearestMetersFrom(LatLng pickup, {DateTime? now}) {
    final at = now ?? DateTime.now();
    final live = kekes.where((k) => !k.isExpiredAt(at));
    if (live.isEmpty) return null;

    double? best;
    for (final k in live) {
      final d = _haversineMeters(
        pickup.latitude, pickup.longitude, k.position.latitude, k.position.longitude);
      if (best == null || d < best) best = d;
    }
    if (best == null) return null;

    // Inside the fuzz radius the figure is noise. Say nothing rather than
    // something precise-sounding and wrong.
    final floor = approximateRadiusMeters > 0 ? approximateRadiusMeters.toDouble() : 150.0;
    if (best < floor) return null;

    return best.round();
  }

  /// "Nearest Keke about 600 m away", or null when no honest figure exists.
  ///
  /// Rounded coarsely on purpose — the underlying position is approximate, so
  /// "about 600 m" is truthful where "612 m" would imply precision we lack.
  String? nearestLabelFrom(LatLng pickup, {DateTime? now}) {
    final m = nearestMetersFrom(pickup, now: now);
    if (m == null) return null;
    if (m < 1000) {
      final rounded = ((m / 100).round() * 100).clamp(100, 900);
      return 'Nearest Keke about $rounded m away';
    }
    final km = (m / 1000).toStringAsFixed(m < 10000 ? 1 : 0);
    return 'Nearest Keke about $km km away';
  }

  static double _haversineMeters(
      double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = (lat2 - lat1) * math.pi / 180;
    final dLng = (lng2 - lng1) * math.pi / 180;
    final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(lat1 * math.pi / 180) *
            math.cos(lat2 * math.pi / 180) *
            math.sin(dLng / 2) *
            math.sin(dLng / 2);
    return 2 * r * math.asin(math.sqrt(a));
  }

  static NearbyKekeFeed fromJson(Map<String, dynamic> json, {required DateTime now}) {
    final fallbackExpiry = now.add(const Duration(seconds: 20));
    final raw = json['markers'];
    final kekes = <NearbyKeke>[];
    if (raw is List) {
      for (final entry in raw) {
        final parsed = NearbyKeke.tryParse(entry, fallbackExpiry: fallbackExpiry);
        if (parsed != null) kekes.add(parsed);
      }
    }
    return NearbyKekeFeed(
      kekes: kekes,
      // Trust the server's honest count, but never report fewer than we drew.
      eligibleCount:
          ((json['eligibleCount'] as num?)?.toInt() ?? kekes.length).clamp(kekes.length, 1 << 30),
      approximateRadiusMeters:
          (json['approximateRadiusMeters'] as num?)?.toInt() ?? 0,
      dispatchRound: (json['dispatchRound'] as num?)?.toInt() ?? 1,
      searchRadiusKm: (json['searchRadiusKm'] as num?)?.toDouble(),
    );
  }
}
