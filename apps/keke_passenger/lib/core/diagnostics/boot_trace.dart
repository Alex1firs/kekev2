import 'dart:convert';

import 'package:flutter/foundation.dart';

/// A stage-by-stage record of the cold-start path.
///
/// ── Why ──────────────────────────────────────────────────────────────────
/// A passenger reported the app stuck on "Reconnecting to your ride…" with
/// working internet. From the outside that is indistinguishable from: an
/// expired session, a request that never returned, a parse that threw, a
/// disposed controller that latched a lock, or a retry chain that quietly
/// died. Every one of those produces the same spinner.
///
/// This records START / SUCCESS / FAILURE and elapsed time for each stage, so
/// the answer is read off a screen rather than guessed at.
///
/// ── Never contains a token or a passenger's identity ─────────────────────
/// Stages record whether a token was PRESENT, never its value; a rideId, never
/// a name, phone or email. A field tester photographs this, so it has to be
/// safe to photograph.
enum BootStage {
  appStart,
  firebaseInit,
  authRestore,
  tokenAvailable,
  apiReady,
  activeRideCheck,
  hydration,
  socketConnect,
  rideRoomJoin,
  uiReady,
}

enum StageStatus { started, success, failure, skipped }

class BootStageRecord {
  BootStageRecord(this.stage, this.status, {this.detail, this.elapsed});

  final BootStage stage;
  final StageStatus status;

  /// A short, non-sensitive note: an HTTP status, a failure reason, a count.
  final String? detail;

  final Duration? elapsed;
  final DateTime at = DateTime.now();

  Map<String, Object?> toMap() => {
        'stage': stage.name,
        'status': status.name,
        if (detail != null) 'detail': detail,
        if (elapsed != null) 'ms': elapsed!.inMilliseconds,
        'at': at.toIso8601String(),
      };
}

/// Process-wide, because it spans the app's whole startup — several
/// independent objects contribute to it and none of them owns it.
class BootTrace {
  BootTrace._();
  static final BootTrace instance = BootTrace._();

  final List<BootStageRecord> _records = [];
  final Map<BootStage, DateTime> _startedAt = {};
  final DateTime processStart = DateTime.now();

  List<BootStageRecord> get records => List.unmodifiable(_records);

  void start(BootStage stage, {String? detail}) {
    _startedAt[stage] = DateTime.now();
    _add(BootStageRecord(stage, StageStatus.started, detail: detail));
  }

  void success(BootStage stage, {String? detail}) =>
      _finish(stage, StageStatus.success, detail);

  void failure(BootStage stage, {String? detail}) =>
      _finish(stage, StageStatus.failure, detail);

  void skipped(BootStage stage, {String? detail}) =>
      _add(BootStageRecord(stage, StageStatus.skipped, detail: detail));

  void _finish(BootStage stage, StageStatus status, String? detail) {
    final began = _startedAt[stage];
    _add(BootStageRecord(
      stage,
      status,
      detail: detail,
      elapsed: began == null ? null : DateTime.now().difference(began),
    ));
  }

  void _add(BootStageRecord r) {
    // Bounded: a retry loop must not grow this without limit over a long trip.
    if (_records.length > 200) _records.removeRange(0, 50);
    _records.add(r);
    // ignore: avoid_print
    if (kDebugMode || _verbose) print('[BOOT] ${jsonEncode(r.toMap())}');
  }

  static const bool _verbose =
      bool.fromEnvironment('FIELD_TEST', defaultValue: false);

  /// The latest status of a stage, for the diagnostics strip.
  BootStageRecord? latest(BootStage stage) {
    for (var i = _records.length - 1; i >= 0; i--) {
      if (_records[i].stage == stage) return _records[i];
    }
    return null;
  }

  /// Compact one-line summary per stage, newest status wins.
  List<String> get summary => BootStage.values.map((s) {
        final r = latest(s);
        if (r == null) return '${s.name}: —';
        final ms = r.elapsed == null ? '' : ' ${r.elapsed!.inMilliseconds}ms';
        final d = r.detail == null ? '' : ' (${r.detail})';
        return '${s.name}: ${r.status.name}$ms$d';
      }).toList();

  @visibleForTesting
  void reset() {
    _records.clear();
    _startedAt.clear();
  }
}
