import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../data/communication_preferences_repository.dart';
import '../communication_preferences_screen.dart';

/// The one-time ask.
///
/// ── When this is allowed to appear ───────────────────────────────────────
/// Only from the home screen, only when the passenger has no ride in progress.
/// A sheet that slides up while somebody is watching for their Keke, paying,
/// entering an OTP or pressing an emergency button is not a marketing
/// opportunity — it is an obstruction, and the caller enforces that by not
/// calling [maybeShow] from any of those states.
///
/// ── Why the decline is a full-width button ───────────────────────────────
/// "Not now" is the same size and weight as the accept, and neither is styled
/// to look like the only option. Consent extracted by making refusal awkward is
/// consent that produces spam complaints later, and a complaint costs the
/// sending domain that also carries verification codes.
class CommunicationOptInPrompt {
  const CommunicationOptInPrompt._();

  /// Ask the server whether to show it, then show it.
  ///
  /// The decision is the server's, so reinstalling the app cannot reset it — a
  /// passenger who declined stays declined. Every failure path here is silent
  /// and results in NOT showing the prompt, because not asking is always safe.
  static Future<void> maybeShow(BuildContext context, WidgetRef ref, {String? appVersion}) async {
    final repo = ref.read(communicationPreferencesRepositoryProvider);

    final decision = await repo.shouldShowPrompt();
    if (!decision) return;
    if (!context.mounted) return;

    // Recorded before it is displayed. If the passenger force-quits while it is
    // on screen we must still count the ask, or somebody who keeps dismissing
    // by killing the app would be shown it forever.
    unawaited(repo.recordPromptShown());

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      // Dismissible by tapping away: an ask nobody can escape is not an ask.
      // Dismissing without answering leaves the decision open, and earns one
      // reminder later rather than nothing.
      isDismissible: true,
      enableDrag: true,
      builder: (sheetContext) => CommunicationOptInSheet(repo: repo, appVersion: appVersion),
    );
  }
}

/// Fire and forget, without importing dart:async for one call.
void unawaited(Future<void> future) {
  future.catchError((_) {});
}

/// The sheet body.
///
/// Public so a golden test can render the widget passengers actually see,
/// rather than a reconstruction of it that could drift.
class CommunicationOptInSheet extends StatefulWidget {
  const CommunicationOptInSheet({super.key, required this.repo, this.appVersion});

  final CommunicationPreferencesRepository repo;
  final String? appVersion;

  @override
  State<CommunicationOptInSheet> createState() => _OptInSheetState();
}

class _OptInSheetState extends State<CommunicationOptInSheet> {
  bool _busy = false;

  Future<void> _answer(bool accepted) async {
    if (_busy) return;
    setState(() => _busy = true);

    await widget.repo.answerPrompt(accepted: accepted, appVersion: widget.appVersion);
    if (!mounted) return;
    Navigator.of(context).pop();

    if (accepted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Thank you — we will keep you posted.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.charcoal,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      padding: EdgeInsets.fromLTRB(
        24, 12, 24, 24 + MediaQuery.of(context).padding.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40, height: 4,
              margin: const EdgeInsets.only(bottom: 22),
              decoration: BoxDecoration(
                color: AppColors.midGray,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),

          Container(
            width: 52, height: 52,
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Icon(Icons.notifications_active_outlined,
                color: AppColors.primary, size: 26),
          ),
          const SizedBox(height: 18),

          Text('Stay connected with KekeRide',
              style: AppTextStyles.title(color: Colors.white)),
          const SizedBox(height: 10),

          Text(
            'Get useful updates, special offers, new service-area announcements '
            'and occasional rewards. You can change your preferences at any time.',
            style: AppTextStyles.bodySmall(color: AppColors.lightGray),
          ),
          const SizedBox(height: 14),

          // Said plainly, because the commonest reason to refuse is a fear of
          // losing something you need.
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.lock_outline, size: 15, color: AppColors.midGray),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Ride updates, receipts and verification codes are always sent, '
                  'whatever you choose.',
                  style: AppTextStyles.bodySmall(color: AppColors.midGray)
                      .copyWith(fontSize: 12),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),

          _PromptButton(
            label: 'Yes, keep me updated',
            filled: true,
            enabled: !_busy,
            onTap: () => _answer(true),
          ),
          const SizedBox(height: 10),

          // Same size, same prominence. Not a greyed-out afterthought.
          _PromptButton(
            label: 'Not now',
            filled: false,
            enabled: !_busy,
            onTap: () => _answer(false),
          ),
          const SizedBox(height: 6),

          TextButton(
            onPressed: _busy
                ? null
                : () {
                    Navigator.of(context).pop();
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const CommunicationPreferencesScreen(),
                      ),
                    );
                  },
            child: Text('Manage preferences',
                style: AppTextStyles.bodySmall(color: AppColors.primary)),
          ),
        ],
      ),
    );
  }
}

class _PromptButton extends StatelessWidget {
  const _PromptButton({
    required this.label,
    required this.filled,
    required this.enabled,
    required this.onTap,
  });

  final String label;
  final bool filled;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: filled
          ? ElevatedButton(
              onPressed: enabled ? onTap : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.charcoal,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: Text(label,
                  style: AppTextStyles.body(color: AppColors.charcoal,
                      weight: FontWeight.w700)),
            )
          : OutlinedButton(
              onPressed: enabled ? onTap : null,
              style: OutlinedButton.styleFrom(
                side: const BorderSide(color: AppColors.midGray),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: Text(label,
                  style: AppTextStyles.body(color: Colors.white)),
            ),
    );
  }
}
