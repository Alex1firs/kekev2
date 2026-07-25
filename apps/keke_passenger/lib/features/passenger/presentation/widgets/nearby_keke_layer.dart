import 'dart:async';
import 'dart:ui' show Offset;

import 'package:flutter/foundation.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../domain/nearby_keke.dart';

/// Tracked visual state for one nearby-Keke marker.
@immutable
class _TrackedKeke {
  final String key;
  final LatLng from;
  final LatLng to;
  final double fromAlpha;
  final double toAlpha;
  /// True once the marker has faded out and may be dropped.
  final bool departing;

  const _TrackedKeke({
    required this.key,
    required this.from,
    required this.to,
    required this.fromAlpha,
    required this.toAlpha,
    this.departing = false,
  });

  LatLng positionAt(double t) => LatLng(
        from.latitude + (to.latitude - from.latitude) * t,
        from.longitude + (to.longitude - from.longitude) * t,
      );

  double alphaAt(double t) => fromAlpha + (toAlpha - fromAlpha) * t;
}

/// Animates the nearby-Keke marker set between server refreshes.
///
/// Why this exists: the previous nearby markers were keyed by list INDEX, so
/// every refresh that reordered the list moved unrelated markers and made the
/// map flicker. Markers here are keyed by the server's stable per-ride handle,
/// so a driver that persists across refreshes is the same marker and simply
/// glides to its new approximate position.
///
/// Performance notes for low-end Android:
///  * At most [NearbyKekeFeed] supplies a handful of markers (server-capped),
///    so the tween touches very few objects.
///  * A single timer drives all markers, running only while a transition is in
///    flight and stopping itself immediately afterwards — nothing ticks while
///    the marker set is stable, which is most of the time.
///  * Bitmaps are supplied by the caller and cached there, never rebuilt here.
class NearbyKekeLayer extends ChangeNotifier {
  NearbyKekeLayer({
    this.tweenDuration = const Duration(milliseconds: 450),
    this.tweenSteps = 9,
  });

  /// How long an add / move / remove transition takes.
  final Duration tweenDuration;

  /// Frames per transition. Deliberately low: enough to read as motion rather
  /// than a jump, cheap enough for a budget device.
  final int tweenSteps;

  final Map<String, _TrackedKeke> _tracked = {};
  Timer? _timer;
  int _step = 0;
  bool _disposed = false;

  /// Current interpolation position, 0..1.
  double get _t => tweenSteps <= 0 ? 1.0 : (_step / tweenSteps).clamp(0.0, 1.0);

  @visibleForTesting
  int get trackedCount => _tracked.length;

  @visibleForTesting
  bool get isAnimating => _timer != null;

  /// Keys currently drawn (including those fading out).
  @visibleForTesting
  Set<String> get trackedKeys => _tracked.keys.toSet();

  /// Feed the latest server snapshot in. Markers absent from [kekes] fade out
  /// and are then removed — a driver who is no longer eligible does not linger.
  void update(List<NearbyKeke> kekes) {
    if (_disposed) return;

    final incoming = {for (final k in kekes) k.key: k};
    final next = <String, _TrackedKeke>{};
    final t = _t;

    for (final entry in incoming.entries) {
      final existing = _tracked[entry.key];
      if (existing == null) {
        // New marker: fade in at its position (no slide from nowhere).
        next[entry.key] = _TrackedKeke(
          key: entry.key,
          from: entry.value.position,
          to: entry.value.position,
          fromAlpha: 0.0,
          toAlpha: 1.0,
        );
      } else {
        // Persisting marker: glide from where it is being drawn right now, so an
        // update mid-transition does not snap.
        next[entry.key] = _TrackedKeke(
          key: entry.key,
          from: existing.positionAt(t),
          to: entry.value.position,
          fromAlpha: existing.alphaAt(t),
          toAlpha: 1.0,
        );
      }
    }

    for (final entry in _tracked.entries) {
      if (incoming.containsKey(entry.key)) continue;
      final current = entry.value;
      if (current.departing && current.alphaAt(t) <= 0.01) continue; // gone
      // Fade out in place, then drop.
      next[entry.key] = _TrackedKeke(
        key: entry.key,
        from: current.positionAt(t),
        to: current.positionAt(t),
        fromAlpha: current.alphaAt(t),
        toAlpha: 0.0,
        departing: true,
      );
    }

    _tracked
      ..clear()
      ..addAll(next);

    if (_tracked.isEmpty) {
      _stopTimer();
      notifyListeners();
      return;
    }
    _startTransition();
  }

  /// Drop everything immediately — used when a driver accepts or the ride ends,
  /// where a fade-out would leave unrelated markers briefly on screen.
  void clear() {
    _stopTimer();
    if (_tracked.isEmpty) return;
    _tracked.clear();
    if (!_disposed) notifyListeners();
  }

  void _startTransition() {
    _step = 0;
    _timer?.cancel();
    if (tweenSteps <= 0) {
      _finishTransition();
      return;
    }
    final tick = Duration(
      milliseconds: (tweenDuration.inMilliseconds / tweenSteps).round().clamp(1, 1000),
    );
    _timer = Timer.periodic(tick, (_) {
      _step++;
      if (_step >= tweenSteps) {
        _finishTransition();
      } else if (!_disposed) {
        notifyListeners();
      }
    });
    notifyListeners();
  }

  void _finishTransition() {
    _stopTimer();
    // Settle at the target and evict fully faded markers.
    _tracked.removeWhere((_, v) => v.toAlpha <= 0.01);
    _tracked.updateAll((_, v) => _TrackedKeke(
          key: v.key,
          from: v.to,
          to: v.to,
          fromAlpha: v.toAlpha,
          toAlpha: v.toAlpha,
        ));
    _step = 0;
    if (!_disposed) notifyListeners();
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
  }

  /// Build the marker set. [icon] is the cached branded Keke bitmap.
  ///
  /// Markers are non-tappable and carry no info window: there is nothing about a
  /// pre-assignment driver a passenger is allowed to inspect.
  Set<Marker> markers({required BitmapDescriptor icon}) {
    final t = _t;
    return {
      for (final tracked in _tracked.values)
        Marker(
          // Stable id derived from the server's per-ride handle.
          markerId: MarkerId('nearby_keke_${tracked.key}'),
          position: tracked.positionAt(t),
          icon: icon,
          alpha: tracked.alphaAt(t).clamp(0.0, 1.0),
          anchor: const Offset(0.5, 0.5),
          consumeTapEvents: true,
          zIndex: 1,
        ),
    };
  }

  @override
  void dispose() {
    _disposed = true;
    _stopTimer();
    _tracked.clear();
    super.dispose();
  }
}
