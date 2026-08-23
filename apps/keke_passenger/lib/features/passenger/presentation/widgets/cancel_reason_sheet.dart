import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';

/// Why a passenger is cancelling, as the canonical code stored on the ride.
///
/// The code is what reaches `Ride.cancellationReason`; the label is only ever
/// shown. Keeping them apart means Operations can count causes over months
/// while the wording on screen stays free to change — and a reworded button
/// never silently rewrites history.
class CancelReason {
  const CancelReason(this.code, this.label);

  final String code;
  final String label;

  /// Mirrors PASSENGER_CANCEL_REASONS on the server, which validates the code.
  static const options = <CancelReason>[
    CancelReason('driver_taking_too_long', 'Driver is taking too long'),
    CancelReason('driver_too_far', 'Driver is too far from pickup'),
    CancelReason('cannot_reach_driver', "I can't reach the driver"),
    CancelReason('driver_asked_to_cancel', 'Driver asked me to cancel'),
    CancelReason('plans_changed', 'My plans changed'),
    CancelReason('wrong_pickup_or_destination', 'Wrong pickup or destination'),
    CancelReason('booked_by_mistake', 'I booked by mistake'),
    CancelReason('other', 'Other'),
  ];
}

/// Two-step cancellation.
///
/// ── Why two steps ───────────────────────────────────────────────────────
/// Cancel used to fire on the first tap, sitting under a thumb on the
/// searching screen. That is one mis-tap away from ending a ride somebody
/// wanted, and it left Operations with 'passenger_cancelled' and no idea why.
///
/// So the first tap only opens this sheet — nothing is cancelled, no request
/// is sent, and the ride is untouched. Choosing a reason still cancels
/// nothing. Only the final destructive button does, and "Keep my ride" closes
/// the sheet having changed nothing at all.
class CancelReasonSheet extends StatefulWidget {
  const CancelReasonSheet({super.key});

  /// Returns the chosen reason code, or null if the passenger kept their ride.
  static Future<String?> show(BuildContext context) {
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const CancelReasonSheet(),
    );
  }

  @override
  State<CancelReasonSheet> createState() => _CancelReasonSheetState();
}

class _CancelReasonSheetState extends State<CancelReasonSheet> {
  CancelReason? _selected;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);

    return Container(
      constraints: BoxConstraints(maxHeight: media.size.height * 0.85),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.symmetric(vertical: 12),
              decoration: BoxDecoration(
                color: AppColors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Why do you want to cancel?',
                      style: AppTextStyles.title()),
                  const SizedBox(height: 6),
                  Text(
                    'Your ride has not been cancelled yet.',
                    style: AppTextStyles.caption(color: AppColors.midGray),
                  ),
                ],
              ),
            ),

            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: CancelReason.options.length,
                separatorBuilder: (_, __) => const SizedBox(height: 8),
                itemBuilder: (context, i) {
                  final option = CancelReason.options[i];
                  final chosen = _selected?.code == option.code;
                  return InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => setState(() => _selected = option),
                    child: Container(
                      // Thumb-friendly: a full-width row with a large target,
                      // not a dense radio list.
                      constraints: const BoxConstraints(minHeight: 52),
                      padding:
                          const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(
                        color: chosen ? AppColors.infoSurface : Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: chosen ? AppColors.info : AppColors.border,
                          width: chosen ? 1.5 : 1,
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            chosen
                                ? Icons.radio_button_checked
                                : Icons.radio_button_unchecked,
                            size: 20,
                            color: chosen ? AppColors.info : AppColors.lightGray,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(option.label,
                                style: AppTextStyles.body()),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),

            Padding(
              padding: EdgeInsets.fromLTRB(
                  16, 16, 16, 16 + media.viewInsets.bottom),
              child: Column(
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.error,
                        foregroundColor: Colors.white,
                        minimumSize: const Size(double.infinity, 52),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14)),
                      ),
                      // Disabled until a reason is chosen: the destructive
                      // action should never be the easiest thing to hit.
                      onPressed: _selected == null
                          ? null
                          : () => Navigator.of(context).pop(_selected!.code),
                      child: const Text('Cancel ride'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    child: TextButton(
                      style: TextButton.styleFrom(
                        minimumSize: const Size(double.infinity, 48),
                      ),
                      // Closes with null — the caller cancels nothing.
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text('Keep my ride',
                          style: AppTextStyles.body(weight: FontWeight.w600)),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
