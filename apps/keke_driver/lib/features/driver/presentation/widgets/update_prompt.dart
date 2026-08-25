import 'package:flutter/material.dart';

import '../../../../core/services/app_update_service.dart';

/// The update prompt.
///
/// Two shapes, and the difference is the point:
///
///   OPTIONAL  dismissible, "Later" is a real answer, the driver keeps working.
///   REQUIRED  no dismiss, no back button — this build can no longer receive
///             trips, so pretending otherwise would waste their shift.
///
/// Required is rare by construction: the server only reports it when somebody
/// has deliberately raised `minimumSupportedBuild`, which defaults to off.
class UpdatePrompt extends StatelessWidget {
  const UpdatePrompt({super.key, required this.status, required this.onUpdate});

  final AppUpdateStatus status;

  /// Returns false when the store could not be opened, so the dialog stays up
  /// instead of the button appearing to do nothing.
  final Future<bool> Function() onUpdate;

  static Future<void> show(
    BuildContext context, {
    required AppUpdateStatus status,
    required Future<bool> Function() onUpdate,
    required VoidCallback onLater,
  }) async {
    await showDialog<void>(
      context: context,
      // A required update cannot be tapped away or backed out of.
      barrierDismissible: !status.updateRequired,
      builder: (_) => PopScope(
        canPop: !status.updateRequired,
        child: UpdatePrompt(status: status, onUpdate: onUpdate),
      ),
    );
    if (!status.updateRequired) onLater();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final required = status.updateRequired;

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      icon: Icon(
        required ? Icons.system_update : Icons.download_for_offline_outlined,
        size: 34,
        color: required ? theme.colorScheme.error : theme.colorScheme.primary,
      ),
      title: Text(
        required
            ? 'Please update KekeRide Driver'
            : 'A new KekeRide Driver update is available',
        textAlign: TextAlign.center,
        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            required
                ? 'Please update KekeRide Driver to continue receiving trips '
                    'reliably.'
                : (status.message.isNotEmpty
                    ? status.message
                    : 'Update to get the latest reliability improvements.'),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
          if (status.latestVersion.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text('Version ${status.latestVersion}',
                style: theme.textTheme.bodySmall),
          ],
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: () async {
              final opened = await onUpdate();
              // Only close on success. If the store would not open, the driver
              // needs the dialog to still be there.
              if (opened && context.mounted && !required) {
                Navigator.of(context).maybePop();
              }
            },
            child: Text(required ? 'Update KekeRide' : 'Update now'),
          ),
        ),
        if (!required)
          SizedBox(
            width: double.infinity,
            child: TextButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('Later'),
            ),
          ),
      ],
    );
  }
}
