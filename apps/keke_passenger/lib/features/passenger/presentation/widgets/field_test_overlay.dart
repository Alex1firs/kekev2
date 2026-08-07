import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/diagnostics/boot_trace.dart';
import '../../application/active_ride_recovery.dart';
import '../../application/booking_controller.dart';
import '../../domain/booking_state.dart';

/// A live readout of the trip stream, for field testing on a real road.
///
/// ── Why this exists ──────────────────────────────────────────────────────
/// "The marker stopped moving" is a symptom, not a diagnosis. It is produced
/// identically by a dead socket, a ride room the client silently left, a driver
/// whose GPS stopped publishing, and a passenger app that received updates and
/// failed to render them. Standing at the roadside with a frozen screen, there
/// was no way to tell which.
///
/// ── Not visible to passengers ────────────────────────────────────────────
/// Compiled behind a const `bool.fromEnvironment`, so in an ordinary release
/// build [enabled] is a compile-time false and the tree-shaker removes the
/// whole widget. There is no runtime toggle, no gesture and no setting — a
/// diagnostics panel a passenger can summon is a diagnostics panel a passenger
/// will eventually screenshot.
///
///   flutter build apk --dart-define=FIELD_TEST=true
class FieldTestOverlay extends ConsumerStatefulWidget {
  const FieldTestOverlay({super.key});

  /// Compile-time flag. False in every ordinary build.
  static const bool enabled = bool.fromEnvironment('FIELD_TEST', defaultValue: false);

  @override
  ConsumerState<FieldTestOverlay> createState() => _FieldTestOverlayState();
}

class _FieldTestOverlayState extends ConsumerState<FieldTestOverlay> {
  Timer? _tick;
  bool _expanded = true;

  @override
  void initState() {
    super.initState();
    // The interesting values are elapsed times, which change with no state
    // change to rebuild on.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!FieldTestOverlay.enabled) return const SizedBox.shrink();

    // Watched so the panel rebuilds on every ride state change too.
    ref.watch(bookingControllerProvider);
    final d = ref.read(bookingControllerProvider.notifier).liveDiagnostics;

    // Deliberately NOT gated on having a ride any more. The failure being
    // hunted happens while recovery is still deciding whether a ride exists,
    // so hiding the panel until a ride is known hid it exactly when it was
    // needed.
    final booking = ref.read(bookingControllerProvider.notifier);
    final st = ref.read(bookingControllerProvider);
    final recovering =
        st.step == BookingStep.loading || st.rideRestoreFailed;
    if (d.rideId == null && !recovering) return const SizedBox.shrink();

    Color tone(bool ok) => ok ? const Color(0xFF34D399) : const Color(0xFFF87171);
    final locAge = d.secondsSinceLocation;
    final locOk = locAge != null && locAge < 30;

    return Positioned(
      left: 8,
      right: 8,
      top: MediaQuery.of(context).padding.top + 8,
      child: Material(
        color: Colors.black.withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: () => setState(() => _expanded = !_expanded),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            child: DefaultTextStyle(
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 10.5,
                color: Colors.white,
                height: 1.5,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      const Text('FIELD TEST  ',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 10)),
                      _dot(tone(d.socketConnected)),
                      const Text(' socket  '),
                      _dot(tone(!d.roomMembershipSuspect)),
                      const Text(' room  '),
                      _dot(tone(locOk)),
                      const Text(' gps'),
                      const Spacer(),
                      Text(_expanded ? '▾' : '▸'),
                    ],
                  ),
                  if (_expanded) ...[
                    const SizedBox(height: 4),
                    // ── Recovery diagnostics. The stuck-on-reconnecting case.
                    _row('auth', _stage(BootStage.authRestore)),
                    _row('token', _stage(BootStage.tokenAvailable)),
                    _row('api', _stage(BootStage.activeRideCheck)),
                    _row('attempt', '#${booking.recoveryAttempts}'),
                    _row('last error',
                        booking.lastRecoveryFailure?.wire ??
                            (booking.lastRecoveryStatus == null
                                ? '—'
                                : 'http ${booking.lastRecoveryStatus}')),
                    _row('ride?',
                        d.rideId != null ? 'found' : (recovering ? 'unknown' : 'none')),
                    const SizedBox(height: 4),
                    _row('ride', d.rideId ?? '—'),
                    _row('status', d.step),
                    _row('room', d.joinedRideRoom ?? 'NOT JOINED'),
                    _row('last gps', locAge == null ? 'never' : '${locAge}s ago'),
                    _row('last event',
                        d.secondsSinceRideEvent == null ? '—' : '${d.secondsSinceRideEvent}s ago'),
                    _row('reconciled',
                        d.secondsSinceReconcile == null ? 'never' : '${d.secondsSinceReconcile}s ago'),
                    _row('driver',
                        d.driverLocation == null
                            ? '—'
                            : '${d.driverLocation!.latitude.toStringAsFixed(5)}, '
                                '${d.driverLocation!.longitude.toStringAsFixed(5)}'),
                    _row('remaining',
                        d.remainingMeters == null ? '—' : '${d.remainingMeters!.round()} m'),
                    _row('eta', d.etaMinutes == null ? '—' : '${d.etaMinutes!.round()} min'),
                    _row('monitor', d.monitorRunning ? 'running' : 'STOPPED'),
                    if (d.streamStale)
                      const Text('STREAM STALE — repairing',
                          style: TextStyle(color: Color(0xFFFBBF24))),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Latest status of a boot stage, compactly.
  String _stage(BootStage stage) {
    final r = BootTrace.instance.latest(stage);
    if (r == null) return '—';
    final ms = r.elapsed == null ? '' : ' ${r.elapsed!.inMilliseconds}ms';
    final d = r.detail == null ? '' : ' ${r.detail}';
    return '${r.status.name}$ms$d';
  }

  Widget _dot(Color c) => Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(color: c, shape: BoxShape.circle),
      );

  Widget _row(String label, String value) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(label, style: const TextStyle(color: Color(0xFF94A3B8))),
          ),
          Expanded(child: Text(value)),
        ],
      );
}
