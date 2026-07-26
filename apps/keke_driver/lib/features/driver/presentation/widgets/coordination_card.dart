import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../domain/ride_coordination.dart';

/// The delayed-ride coordination card, driver side.
///
/// This is deliberately NOT an error surface. A driver held up at a checkpoint
/// has done nothing wrong, and a card that looks like a warning notice reads as an
/// accusation. So: cream surface, amber accent, plain language, and red used only
/// on the confirmation step of an action that actually ends the ride.
///
/// Mirrors the passenger app's card. Kept separate because the two apps are
/// independent Flutter projects, but the behaviour — server-anchored countdown,
/// confirmation on destructive actions, no-red styling, one leaf semantics node —
/// is intentionally the same on both sides.
///
/// The countdown is rendered from the server's absolute deadline and re-read once
/// a second from the wall clock, so backgrounding the app for a minute costs a
/// minute — the timer here only decides when to repaint, never what the remaining
/// time is.
class CoordinationCard extends StatefulWidget {
  final RideCoordination coordination;

  /// Called with the action the passenger chose. Destructive actions have already
  /// been confirmed by the time this fires.
  final void Function(CoordinationAction action) onAction;

  /// Injected in tests so a countdown can be asserted without waiting.
  final DateTime Function()? clock;

  const CoordinationCard({
    super.key,
    required this.coordination,
    required this.onAction,
    this.clock,
  });

  @override
  State<CoordinationCard> createState() => _CoordinationCardState();
}

class _CoordinationCardState extends State<CoordinationCard> {
  Timer? _tick;

  DateTime get _now => (widget.clock ?? DateTime.now)();

  @override
  void initState() {
    super.initState();
    _syncTicker();
  }

  @override
  void didUpdateWidget(CoordinationCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncTicker();
  }

  /// Only run a ticker while there is actually a countdown to repaint.
  void _syncTicker() {
    final needsTicker = widget.coordination.respondByAt != null &&
        !widget.coordination.answered;
    if (needsTicker && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!needsTicker) {
      _tick?.cancel();
      _tick = null;
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.coordination;
    final now = _now;
    final expired = c.hasExpired(now);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
      decoration: BoxDecoration(
        // Cream and amber. This is a coordination state, not a failure.
        color: AppColors.infoSurface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.infoBorder),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // One leaf node for the whole message, so a screen reader announces the
          // situation and the remaining time as a single sentence rather than
          // four disconnected fragments.
          Semantics(
            container: true,
            liveRegion: true,
            label: c.accessibilityLabel(now),
            excludeSemantics: true,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.info.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(_iconFor(c.stage), size: 21, color: AppColors.info),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        c.title,
                        style: AppTextStyles.body(
                          color: AppColors.charcoal,
                          weight: FontWeight.w700,
                        ),
                      ),
                      if (c.body.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          c.body,
                          style: AppTextStyles.bodySmall(color: AppColors.darkGray),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),

          // The countdown, in words as well as figures. A number that only shrinks
          // and changes colour is invisible to a screen reader and to anyone who
          // cannot distinguish amber from grey.
          if (c.respondByAt != null && !c.answered) ...[
            const SizedBox(height: 12),
            _CountdownRow(
              secondsRemaining: c.secondsRemaining(now) ?? 0,
              expired: expired,
            ),
          ],

          if (c.submitting) ...[
            const SizedBox(height: 12),
            _StatusLine(
              key: const Key('coordination-submitting'),
              icon: Icons.hourglass_top_rounded,
              text: 'Sending your response…',
            ),
          ] else if (c.answered) ...[
            const SizedBox(height: 12),
            _StatusLine(
              key: const Key('coordination-answered'),
              icon: Icons.check_circle_outline_rounded,
              text: _answeredCopy(c),
            ),
          ] else if (expired) ...[
            const SizedBox(height: 12),
            // Honest about a window that closed, without claiming an outcome the
            // server has not reported. Only the backend ends a ride.
            _StatusLine(
              key: const Key('coordination-expired'),
              icon: Icons.info_outline_rounded,
              text: 'The time to respond has passed. The ride is still active '
                  'while we sort this out.',
            ),
          ],

          if (c.requestedByMe &&
              c.stage == CoordinationStage.cancellationRequested) ...[
            const SizedBox(height: 12),
            _StatusLine(
              key: const Key('coordination-pending-request'),
              icon: Icons.hourglass_empty_rounded,
              text: 'Waiting for a response. The ride stays active until they answer.',
            ),
          ],

          if (_visibleActions(c).isNotEmpty) ...[
            const SizedBox(height: 14),
            ..._buildActions(context, c),
          ],
        ],
      ),
    );
  }

  /// Actions worth drawing. A destructive action is always offered last, so it is
  /// never the first thing a thumb or a screen reader reaches.
  List<CoordinationAction> _visibleActions(RideCoordination c) {
    if (c.submitting) return const [];
    final actions = c.actions.where((a) {
      // Never offer "Continue waiting" the backend would refuse.
      if (a == CoordinationAction.keepWaiting && c.extensionsRemaining <= 0) {
        return false;
      }
      return true;
    }).toList();
    actions.sort((a, b) {
      if (a.isDestructive == b.isDestructive) return 0;
      return a.isDestructive ? 1 : -1;
    });
    return actions;
  }

  List<Widget> _buildActions(BuildContext context, RideCoordination c) {
    final actions = _visibleActions(c);
    final widgets = <Widget>[];
    for (var i = 0; i < actions.length; i++) {
      final action = actions[i];
      if (i > 0) widgets.add(const SizedBox(height: 8));
      // The first non-destructive action is the primary. A cancel button is never
      // primary and never autofocused, however late the ride is.
      final isPrimary = i == 0 && !action.isDestructive;
      widgets.add(
        _ActionButton(
          action: action,
          primary: isPrimary,
          onPressed: () => _handle(context, action),
        ),
      );
    }
    return widgets;
  }

  Future<void> _handle(BuildContext context, CoordinationAction action) async {
    if (!action.isDestructive) {
      widget.onAction(action);
      return;
    }
    // Every ride-ending action is confirmed. Nobody loses a ride to a mis-tap on
    // a phone in one hand while flagging down traffic with the other.
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          action == CoordinationAction.acceptCancellation
              ? 'Accept the cancellation?'
              : 'Cancel this ride?',
          style: AppTextStyles.body(weight: FontWeight.w700),
        ),
        content: Text(
          action == CoordinationAction.acceptCancellation
              ? 'The ride will end and you can accept new rides.'
              : "We'll ask the passenger to confirm. The ride stays active until they answer.",
          style: AppTextStyles.bodySmall(color: AppColors.darkGray),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Keep the ride'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: AppColors.error),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(action == CoordinationAction.acceptCancellation
                ? 'Accept'
                : 'Cancel ride'),
          ),
        ],
      ),
    );
    if (confirmed == true) widget.onAction(action);
  }

  static String _answeredCopy(RideCoordination c) {
    if (c.stage == CoordinationStage.cancellationRequested) {
      return 'Your response has been sent.';
    }
    // The confirmation the spec asks for verbatim: the driver needs to know the
    // passenger was actually told, not just that a button worked.
    return 'Passenger notified that you are still coming.';
  }

  static IconData _iconFor(CoordinationStage stage) => switch (stage) {
        CoordinationStage.runningLate => Icons.access_time_rounded,
        CoordinationStage.awaitingDecision => Icons.help_outline_rounded,
        CoordinationStage.confirmedEnRoute => Icons.directions_rounded,
        CoordinationStage.waitingForPassenger => Icons.person_pin_circle_outlined,
        CoordinationStage.cancellationRequested => Icons.pan_tool_outlined,
        CoordinationStage.escalated => Icons.support_agent_rounded,
        CoordinationStage.none => Icons.info_outline_rounded,
      };
}

/// The remaining-time row. Text carries the meaning; colour only reinforces it.
class _CountdownRow extends StatelessWidget {
  final int secondsRemaining;
  final bool expired;

  const _CountdownRow({required this.secondsRemaining, required this.expired});

  @override
  Widget build(BuildContext context) {
    final label = expired
        ? 'Time to respond has passed'
        : '${_spell(secondsRemaining)} left to respond';
    return Row(
      children: [
        Icon(
          expired ? Icons.timer_off_outlined : Icons.timer_outlined,
          size: 16,
          color: AppColors.info,
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            label,
            key: const Key('coordination-countdown'),
            style: AppTextStyles.bodySmall(
              color: AppColors.info,
              weight: FontWeight.w600,
            ),
          ),
        ),
      ],
    );
  }

  /// Rounds DOWN, deliberately. With 2m30s left, "3 minutes" promises time that
  /// does not exist; "2 minutes" is the honest floor, and nobody is surprised by
  /// the window closing sooner than the label implied.
  static String _spell(int seconds) {
    if (seconds < 60) return '$seconds ${seconds == 1 ? 'second' : 'seconds'}';
    final minutes = seconds ~/ 60;
    return '$minutes ${minutes == 1 ? 'minute' : 'minutes'}';
  }
}

class _StatusLine extends StatelessWidget {
  final IconData icon;
  final String text;

  const _StatusLine({super.key, required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: text,
      excludeSemantics: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: AppColors.darkGray),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: AppTextStyles.bodySmall(color: AppColors.darkGray),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final CoordinationAction action;
  final bool primary;
  final VoidCallback onPressed;

  const _ActionButton({
    required this.action,
    required this.primary,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    // 48dp minimum: this is tapped by someone standing on a roadside, often in
    // one hand, sometimes in the rain.
    final height = primary ? 50.0 : 46.0;
    final child = primary
        ? ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.charcoal,
              elevation: 0,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
            onPressed: onPressed,
            child: Text(action.label,
                style: AppTextStyles.body(weight: FontWeight.w700)),
          )
        : OutlinedButton(
            style: OutlinedButton.styleFrom(
              // Red text, not a red fill: it must read as available, not as the
              // thing to do.
              foregroundColor:
                  action.isDestructive ? AppColors.error : AppColors.charcoal,
              side: BorderSide(
                color: action.isDestructive
                    ? AppColors.error.withOpacity(0.4)
                    : AppColors.border,
              ),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
            onPressed: onPressed,
            child: Text(action.label,
                style: AppTextStyles.bodySmall(weight: FontWeight.w600)),
          );

    return Semantics(
      button: true,
      label: action.label,
      // A cancel button must not be what a screen reader lands on first, nor what
      // an Enter key press activates.
      excludeSemantics: true,
      child: SizedBox(
        key: Key('coordination-action-${action.name}'),
        height: height,
        child: ExcludeFocus(excluding: action.isDestructive, child: child),
      ),
    );
  }
}

/// The card shown when the backend has closed a ride nobody answered for.
///
/// Separate from [CoordinationCard] because this is an outcome, not a question:
/// there is nothing to decide, and the only useful thing on screen is a way to
/// get back on the road.
class RideClosedCard extends StatelessWidget {
  final String title;
  final String body;
  final RideClosure closure;
  final VoidCallback onPrimaryAction;

  const RideClosedCard({
    super.key,
    required this.title,
    required this.body,
    required this.closure,
    required this.onPrimaryAction,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
      decoration: BoxDecoration(
        // Neutral, not red. Nobody did anything wrong.
        color: AppColors.surfaceVariant,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            container: true,
            liveRegion: true,
            label: '$title. $body',
            excludeSemantics: true,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.midGray.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.event_busy_rounded,
                      size: 21, color: AppColors.midGray),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title,
                          style: AppTextStyles.body(
                              color: AppColors.charcoal,
                              weight: FontWeight.w700)),
                      const SizedBox(height: 4),
                      Text(body,
                          key: const Key('ride-closed-body'),
                          style: AppTextStyles.bodySmall(
                              color: AppColors.darkGray)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Semantics(
            button: true,
            label: closure.primaryAction,
            excludeSemantics: true,
            child: SizedBox(
              key: const Key('ride-closed-primary'),
              height: 50,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.charcoal,
                  elevation: 0,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: onPrimaryAction,
                child: Text(closure.primaryAction,
                    style: AppTextStyles.body(weight: FontWeight.w700)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
