import 'package:flutter/material.dart';

import '../../../../core/services/driver_readiness_service.dart';
import '../../../../core/services/reliability_log.dart';

/// The setup a driver is walked through before KekeRide can reliably reach them.
///
/// ── Why this interrupts going online ────────────────────────────────────
/// On Xiaomi, Oppo, Vivo and Transsion handsets an app that is merely
/// backgrounded stops receiving anything within minutes unless the driver has
/// granted permissions that live in the manufacturer's own security app. There
/// is no API to read them and no way to set them programmatically.
///
/// The alternative to asking is worse: a driver taps ONLINE, sees "You're
/// online", parks, waits, and receives nothing — with the app insisting all is
/// well. That happened on a real Redmi during field testing. Being told once,
/// clearly, beats a silent shift.
///
/// It never blocks going online. A driver who dismisses it still goes ONLINE;
/// they are simply told what it will cost them.
class ReadinessSetupSheet extends StatefulWidget {
  const ReadinessSetupSheet({
    super.key,
    required this.issues,
    required this.onRecheck,
    this.provenUnreachable = false,
  });

  final List<ReadinessIssue> issues;

  /// Re-runs the checks after the driver returns from a system screen.
  final Future<List<ReadinessIssue>> Function() onRecheck;

  /// The server has actually failed to reach this phone — not a guess.
  final bool provenUnreachable;

  static Future<void> show(
    BuildContext context, {
    required List<ReadinessIssue> issues,
    required Future<List<ReadinessIssue>> Function() onRecheck,
    bool provenUnreachable = false,
  }) {
    ReliabilityLog.log('readiness_sheet_shown', {
      'issues': issues.map((i) => i.id).join(','),
      'provenUnreachable': provenUnreachable,
    });
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ReadinessSetupSheet(
        issues: issues,
        onRecheck: onRecheck,
        provenUnreachable: provenUnreachable,
      ),
    );
  }

  @override
  State<ReadinessSetupSheet> createState() => _ReadinessSetupSheetState();
}

class _ReadinessSetupSheetState extends State<ReadinessSetupSheet> {
  late List<ReadinessIssue> _issues = widget.issues;
  final Set<String> _visited = {};
  bool _rechecking = false;

  Future<void> _handle(ReadinessIssue issue) async {
    ReliabilityLog.log('readiness_fix_tapped', {'issue': issue.id});
    setState(() => _visited.add(issue.id));
    await issue.fix();
  }

  Future<void> _recheck() async {
    setState(() => _rechecking = true);
    final next = await widget.onRecheck();
    if (!mounted) return;
    setState(() {
      _issues = next;
      _rechecking = false;
    });
    ReliabilityLog.log('readiness_rechecked', {
      'remaining': next.map((i) => i.id).join(','),
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final critical = _issues
        .where((i) => i.severity == ReadinessSeverity.critical)
        .toList();
    final degraded = _issues
        .where((i) => i.severity == ReadinessSeverity.degraded)
        .toList();
    final allClear = _issues.isEmpty;

    return DraggableScrollableSheet(
      initialChildSize: 0.78,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      expand: false,
      builder: (context, controller) => Container(
        decoration: BoxDecoration(
          color: theme.scaffoldBackgroundColor,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        ),
        child: ListView(
          controller: controller,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          children: [
            Center(
              child: Container(
                width: 40, height: 4,
                margin: const EdgeInsets.only(bottom: 20),
                decoration: BoxDecoration(
                  color: theme.dividerColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),

            if (allClear) ...[
              Icon(Icons.check_circle, size: 48, color: Colors.green.shade600),
              const SizedBox(height: 14),
              Text('Your phone is ready',
                  style: theme.textTheme.titleLarge
                      ?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text(
                'KekeRide can reach you with trips even when the app is closed.',
                style: theme.textTheme.bodyMedium,
              ),
            ] else ...[
              Text(
                widget.provenUnreachable
                    ? 'We could not reach your phone'
                    : 'Finish setting up your phone',
                style: theme.textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              Text(
                widget.provenUnreachable
                    // Measured, not guessed — so it can be said plainly.
                    ? 'We tried to send you ride requests and your phone did '
                        'not answer. Fix the items below so trips reach you '
                        'while KekeRide is closed.'
                    : 'Your phone needs a few permissions before it can '
                        'receive trips while KekeRide is closed. This is a '
                        'one-time setup.',
                style: theme.textTheme.bodyMedium,
              ),
            ],

            const SizedBox(height: 22),
            for (final issue in critical) _IssueTile(
              issue: issue,
              visited: _visited.contains(issue.id),
              onTap: () => _handle(issue),
            ),
            if (degraded.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text('RECOMMENDED',
                  style: theme.textTheme.labelSmall
                      ?.copyWith(letterSpacing: 1.1)),
              const SizedBox(height: 8),
              for (final issue in degraded) _IssueTile(
                issue: issue,
                visited: _visited.contains(issue.id),
                onTap: () => _handle(issue),
              ),
            ],

            const SizedBox(height: 18),
            if (!allClear)
              OutlinedButton.icon(
                onPressed: _rechecking ? null : _recheck,
                icon: _rechecking
                    ? const SizedBox(
                        width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.refresh),
                label: Text(_rechecking ? 'Checking…' : "I've done these — check again"),
              ),
            const SizedBox(height: 10),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              /*
               * Never a hard block. A driver who wants to work anyway may —
               * they simply know the cost now. Blocking would strand somebody
               * whose OEM screen we failed to open.
               */
              child: Text(allClear ? 'Done' : 'Continue anyway'),
            ),
          ],
        ),
      ),
    );
  }
}

class _IssueTile extends StatelessWidget {
  const _IssueTile({
    required this.issue,
    required this.visited,
    required this.onTap,
  });

  final ReadinessIssue issue;
  final bool visited;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isCritical = issue.severity == ReadinessSeverity.critical;
    final accent = isCritical ? Colors.red.shade400 : Colors.amber.shade700;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border(left: BorderSide(color: accent, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                visited ? Icons.help_outline : Icons.error_outline,
                size: 18, color: accent,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(issue.title,
                    style: theme.textTheme.titleSmall
                        ?.copyWith(fontWeight: FontWeight.w600)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(issue.detail, style: theme.textTheme.bodySmall),
          if (visited) ...[
            const SizedBox(height: 8),
            Text(
              // We cannot read these settings back, so we say so rather than
              // ticking it green and being wrong.
              'We cannot check this one automatically — tap "check again" '
              'below once you have turned it on.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(fontStyle: FontStyle.italic),
            ),
          ],
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.tonal(
              onPressed: onTap,
              child: Text(issue.actionLabel),
            ),
          ),
        ],
      ),
    );
  }
}
